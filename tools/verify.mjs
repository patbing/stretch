/**
 * verify.mjs — behavioural tests for STRETCH, run against a real Chrome.
 *
 * These are the promises the extension makes, checked in the browser:
 *   T1  the floating button stays on screen when the page is scrolled
 *   T2  shrink + re-expand costs nothing (no second API request)
 *   T3  the model the reader picked is the model that is called
 *   T4  a failed stretch leaves no trace in the author's paragraph
 *   T5  a selection that crosses inline elements still works
 *
 * Chrome 137+ ignores --load-extension, so the extension is loaded through the
 * DevTools command Extensions.loadUnpacked.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT = process.argv[2];
const KEY = process.env.POL_KEY;
const DEMO = process.env.DEMO_URL || "https://patbing.github.io/stretch/demo.html";
const PORT = 9340;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass++;
    console.log(`PASS  ${name}${detail ? "  — " + detail : ""}`);
  } else {
    fail++;
    console.log(`FAIL  ${name}${detail ? "  — " + detail : ""}`);
  }
}

if (!KEY) {
  console.error("POL_KEY missing");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), "stretch-verify-profile");
fs.rmSync(profile, { recursive: true, force: true });
// a test build: the harness has no activeTab user gesture, so the demo host is allowed
const build = path.join(os.tmpdir(), "stretch-verify-build");
fs.rmSync(build, { recursive: true, force: true });
fs.cpSync(EXT, build, { recursive: true });
{
  const mf = path.join(build, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf-8"));
  m.host_permissions = [...new Set([...(m.host_permissions || []), "https://patbing.github.io/*"])];
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
}

const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--enable-unsafe-extension-debugging",
    "--window-size=1400,900",
    "about:blank",
  ],
  { stdio: ["ignore", "pipe", "pipe"] },
);
let chromeLog = "";
chrome.stderr.on("data", (d) => (chromeLog += d.toString()));

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.p = new Map();
    this.events = [];
    ws.addEventListener("message", (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.p.has(m.id)) {
        const { resolve, reject } = this.p.get(m.id);
        this.p.delete(m.id);
        m.error ? reject(new Error(JSON.stringify(m.error))) : resolve(m.result);
      } else if (m.method) {
        this.events.push(m);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const pay = { id, method, params };
    if (sessionId) pay.sessionId = sessionId;
    return new Promise((res, rej) => {
      this.p.set(id, { resolve: res, reject: rej });
      this.ws.send(JSON.stringify(pay));
      setTimeout(() => {
        if (this.p.has(id)) {
          this.p.delete(id);
          rej(new Error("timeout " + method));
        }
      }, 60000);
    });
  }
  async ev(expr, sid) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression: expr, awaitPromise: true, returnByValue: true },
      sid,
    );
    if (r.exceptionDetails) throw new Error("eval: " + JSON.stringify(r.exceptionDetails).slice(0, 300));
    return r.result ? r.result.value : undefined;
  }
  requestsTo(urlPart) {
    return this.events.filter(
      (e) =>
        e.method === "Network.requestWillBeSent" &&
        e.params &&
        e.params.request &&
        String(e.params.request.url || "").includes(urlPart),
    );
  }
}

async function httpJson(p) {
  const r = await fetch(`http://127.0.0.1:${PORT}${p}`);
  return r.json();
}

let cdp = null;
try {
  // wait for devtools
  let ver = null;
  for (let i = 0; i < 80 && !ver; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) ver = await r.json();
    } catch (e) {
      /* not up */
    }
    await sleep(400);
  }
  if (!ver) throw new Error("devtools never came up");
  const ws = new WebSocket(ver.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r, { once: true }));
  cdp = new CDP(ws);
  await cdp.send("Target.setDiscoverTargets", { discover: true });

  const { id: extId } = await cdp.send("Extensions.loadUnpacked", { path: build });
  console.log("extension loaded:", extId);

  // the extension page (wakes the worker and gives us a privileged context)
  const { targetId: extTarget } = await cdp.send("Target.createTarget", {
    url: `chrome-extension://${extId}/popup.html`,
  });
  const { sessionId: esid } = await cdp.send("Target.attachToTarget", { targetId: extTarget, flatten: true });
  await cdp.send("Runtime.enable", {}, esid);
  await sleep(1200);

  // the demo article
  const { targetId: pageTarget } = await cdp.send("Target.createTarget", { url: DEMO });
  const { sessionId: psid } = await cdp.send("Target.attachToTarget", { targetId: pageTarget, flatten: true });
  await cdp.send("Page.enable", {}, psid);
  await cdp.send("Runtime.enable", {}, psid);
  await sleep(3000);

  // the service worker (it owns the API calls) — attach so we can count them
  let sw = null;
  for (let i = 0; i < 40 && !sw; i++) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    sw = targetInfos.find((t) => t.type === "service_worker" && t.url && t.url.includes(`${extId}/background.js`));
    if (!sw) await sleep(400);
  }
  let wsid = null;
  if (sw) {
    const r = await cdp.send("Target.attachToTarget", { targetId: sw.targetId, flatten: true });
    wsid = r.sessionId;
    await cdp.send("Network.enable", {}, wsid);
    await cdp.send("Runtime.enable", {}, wsid);
    console.log("service worker attached");
  }

  // store the key, refresh the model catalogue through the real path, inject
  const setup = await cdp.ev(
    `(async () => {
       await chrome.storage.local.set({ stretchKey: { accessToken: ${JSON.stringify(KEY)}, connectedAt: Date.now(), expiresAt: null } });
       const priced = await chrome.runtime.sendMessage({ v: 1, type: "REFRESH_PRICING" });
       const self = await chrome.tabs.getCurrent();
       const tabs = (await chrome.tabs.query({})).filter(t => t.id !== (self && self.id));
       const target = tabs[tabs.length - 1];
       await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
       return "ok tab " + target.id + " eligible=" + JSON.stringify(priced && priced.eligible);
     })()`,
    esid,
  );
  console.log("setup:", setup);

  /* ---------------------------------------------------------- helpers */
  const selectIn = async (needle, word) =>
    cdp.ev(
      `(() => {
         const p = [...document.querySelectorAll("p")].find(p => p.textContent.includes(${JSON.stringify(needle)}));
         if (!p) return "paragraph not found";
         const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
         let n, node = null, off = 0;
         while ((n = walker.nextNode())) {
           const i = n.textContent.indexOf(${JSON.stringify(word)});
           if (i >= 0) { node = n; off = i; break; }
         }
         if (!node) return "not found";
         const r = document.createRange();
         r.setStart(node, off);
         r.setEnd(node, off + ${JSON.stringify(word)}.length);
         const s = window.getSelection();
         s.removeAllRanges();
         s.addRange(r);
         document.dispatchEvent(new Event("selectionchange"));
         return "selected " + s.toString();
       })()`,
      psid,
    );

  const buttonBox = () =>
    cdp.ev(
      `(() => {
         const hosts = [...document.querySelectorAll("div")].filter(d => d.style && d.style.position === "fixed" && d.shadowRoot);
         if (!hosts.length) return null;
         const b = hosts[hosts.length - 1].getBoundingClientRect();
         return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width, h: b.height, top: b.top, left: b.left };
       })()`,
      psid,
    );

  const clickAt = async (x, y) => {
    await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, psid);
    await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, psid);
  };

  const hostState = () =>
    cdp.ev(
      `(() => {
         const hosts = [...document.querySelectorAll("[data-stretch-anchor]")];
         if (!hosts.length) return { count: 0 };
         const sh = hosts[0].shadowRoot;
         const add = sh.querySelector(".add");
         const cached = sh.querySelector(".cached");
         const minus = sh.querySelector(".minus");
         const r = hosts[0].getBoundingClientRect();
         return { count: hosts.length, added: !!add, cached: !!cached, minus: !!minus,
                  text: (add || {}).textContent || "", w: r.width, h: r.height };
       })()`,
      psid,
    );

  /* ------------------------------------------------- T1: scrolled page */
  await cdp.ev("window.scrollTo(0, 600); 'scrolled'", psid);
  await sleep(400);
  await selectIn("Carthage was founded", "Carthage");
  await sleep(900);
  const box = await buttonBox();
  const inView = box && box.top >= 0 && box.top < 900 && box.left >= 0;
  check("T1 the Stretch button stays in the viewport on a scrolled page", !!inView, box ? `top=${Math.round(box.top)}` : "no button");

  /* ------------------------------------------------- T2: cache */
  const before = cdp.requestsTo("gen.pollinations.ai").length;
  if (box) await clickAt(box.x, box.y);
  let st = null;
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    st = await hostState();
    if (st.added) break;
  }
  check("T2a the first stretch inserts the addition inline", !!(st && st.added), st && st.text ? st.text.slice(0, 60) : JSON.stringify(st));
  const afterFirst = cdp.requestsTo("gen.pollinations.ai").length;
  check("T2b exactly one API request was made", afterFirst - before === 1, `requests=${afterFirst - before}`);

  // shrink it
  const minusBox = await cdp.ev(
    `(() => {
       const h = document.querySelector("[data-stretch-anchor]");
       if (!h) return null;
       const b = h.shadowRoot.querySelector(".minus");
       if (!b) return null;
       const r = b.getBoundingClientRect();
       return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
     })()`,
    psid,
  );
  if (minusBox) await clickAt(minusBox.x, minusBox.y);
  await sleep(600);
  const gone = await hostState();
  check("T2c the shrink control removes the addition", gone.count === 0, `hosts=${gone.count}`);

  // re-expand the same phrase: must not pay again
  await selectIn("Carthage was founded", "Carthage");
  await sleep(900);
  const box2 = await buttonBox();
  if (box2) await clickAt(box2.x, box2.y);
  let st2 = null;
  for (let i = 0; i < 20; i++) {
    await sleep(700);
    st2 = await hostState();
    if (st2.added) break;
  }
  const afterSecond = cdp.requestsTo("gen.pollinations.ai").length;
  check("T2d re-expanding the same phrase makes no new request", afterSecond === afterFirst, `requests=${afterSecond - afterFirst}`);
  check("T2e the re-expanded addition is marked as cached", !!(st2 && st2.cached), st2 ? `cached=${st2.cached}` : "");

  /* ------------------------------------------------- T3: the model */
  const reqs = cdp.requestsTo("gen.pollinations.ai");
  const bodies = reqs.map((r) => {
    try {
      return JSON.parse(r.params.request.postData || "{}");
    } catch (e) {
      return {};
    }
  });
  const models = bodies.map((b) => b.model).filter(Boolean);
  check("T3 the request used the reader's selected model", models.length > 0 && models.every((m) => m === "openai/gpt-5.4-nano"), `models=${JSON.stringify(models)}`);

  // switch the model in the popup and stretch again
  await cdp.ev(
    `(async () => { await chrome.storage.local.set({ stretchModel: "deepseek/deepseek-v4.1-flash" }); return "ok"; })()`,
    esid,
  );
  await selectIn("The printing press was introduced", "printing press");
  await sleep(900);
  const box3 = await buttonBox();
  if (box3) await clickAt(box3.x, box3.y);
  for (let i = 0; i < 60; i++) {
    await sleep(1000);
    const s = await hostState();
    if (s.added) break;
  }
  const reqs2 = cdp.requestsTo("gen.pollinations.ai");
  const models2 = reqs2
    .map((r) => {
      try {
        return JSON.parse(r.params.request.postData || "{}").model;
      } catch (e) {
        return null;
      }
    })
    .filter(Boolean);
  check("T3b switching the model changes the model that is called", models2.includes("deepseek/deepseek-v4.1-flash"), `models=${JSON.stringify(models2)}`);

  /* ------------------------------------------------- T4: no trace on failure */
  const hostsBefore = (await hostState()).count;
  await cdp.ev(`(async () => { await chrome.storage.local.remove(["stretchKey"]); return "ok"; })()`, esid);
  await selectIn("Carthage was founded", "Phoenician");
  await sleep(900);
  const box4 = await buttonBox();
  if (box4) await clickAt(box4.x, box4.y);
  await sleep(5000);
  const leftovers = await cdp.ev(
    `(() => {
       const hosts = [...document.querySelectorAll("[data-stretch-anchor]")];
       const errText = hosts.some(h => {
         const sh = h.shadowRoot;
         return sh && sh.querySelector(".err");
       });
       return { count: hosts.length, errText, body: document.body.innerText.includes("Connect your Pollen") };
     })()`,
    psid,
  );
  check(
    "T4 a failed stretch leaves no trace in the page",
    leftovers.count === hostsBefore && !leftovers.errText && !leftovers.body,
    `hosts=${leftovers.count}(before ${hostsBefore}) errText=${leftovers.errText} bodyText=${leftovers.body}`,
  );

  /* ------------------------------------------------- T5: cross-inline */
  await cdp.ev(`(async () => { await chrome.storage.local.set({ stretchKey: { accessToken: ${JSON.stringify(KEY)}, connectedAt: Date.now(), expiresAt: null } }); return "ok"; })()`, esid);
  const sel5 = await selectIn("A cross-inline selection", "mercury");
  await sleep(900);
  const box5 = await buttonBox();
  check("T5 a selection inside an inline element still offers Stretch", !!box5, `select=${sel5}`);
} catch (e) {
  console.error("HARNESS FAILED:", e.message);
  console.error(chromeLog.slice(-1200));
  fail++;
} finally {
  try {
    if (cdp) cdp.ws.close();
  } catch (e) {}
  chrome.kill();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
