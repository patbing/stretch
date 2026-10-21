/**
 * drive.mjs — load STRETCH into a real Chrome, stretch a phrase on the demo
 * article, and capture a real screenshot of the result.
 *
 * Chrome runs with --load-extension. The Pollinations key is written into the
 * extension's own chrome.storage.local through the extension's page context
 * (test only — the extension itself has no "paste a key" path).
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const CHROME = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const EXT = process.argv[2] || "C:\\wt\\stretch";
const KEY = process.env.POL_KEY;
const OUT = process.argv[3] || "C:\\wt\\stretch\\screenshot-stretch.png";
const DEMO = process.env.DEMO_URL || "https://patbing.github.io/stretch/demo.html";
const HEADLESS = process.env.HEADFUL !== "1";
const PORT = 9334;

if (!KEY) {
  console.error("POL_KEY missing");
  process.exit(2);
}

const profile = path.join(os.tmpdir(), "stretch-chrome-profile");
fs.rmSync(profile, { recursive: true, force: true });

/**
 * The shipped extension only asks for activeTab, which Chrome grants when the
 * user clicks the action icon. A headless harness has no such gesture, so for
 * the screenshot we load a COPY that additionally lists the demo host. The
 * content script, the service worker and the API call are the same code.
 */
let extPath = EXT;
if (process.env.TEST_HOST) {
  const copy = path.join(os.tmpdir(), "stretch-testbuild");
  fs.rmSync(copy, { recursive: true, force: true });
  fs.cpSync(EXT, copy, { recursive: true });
  const mf = path.join(copy, "manifest.json");
  const m = JSON.parse(fs.readFileSync(mf, "utf-8"));
  m.host_permissions = [...new Set([...(m.host_permissions || []), process.env.TEST_HOST + "/*"])];
  fs.writeFileSync(mf, JSON.stringify(m, null, 2));
  extPath = copy;
  console.log("test build (extra host permission):", extPath, "->", process.env.TEST_HOST);
}

const args = [
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  // Chrome 137+ ignores --load-extension; Extensions.loadUnpacked is used instead.
  "--no-first-run",
  "--no-default-browser-check",
  "--enable-unsafe-extension-debugging",
  "--disable-features=Translate,OptimizationHints,DisableLoadExtensionCommandLineSwitch",
  "--window-size=1600,900",
  "--hide-scrollbars",
  "about:blank",
];
if (HEADLESS) args.unshift("--headless=new");

const chrome = spawn(CHROME, args, { stdio: ["ignore", "pipe", "pipe"] });
let chromeLog = "";
chrome.stderr.on("data", (d) => (chromeLog += d.toString()));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function httpJson(path) {
  const r = await fetch(`http://127.0.0.1:${PORT}${path}`);
  return r.json();
}

async function waitForDevtools() {
  for (let i = 0; i < 80; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (r.ok) return await r.json();
    } catch (e) {}
    await sleep(500);
  }
  throw new Error("devtools never came up\n" + chromeLog.slice(-1200));
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.id = 0;
    this.pending = new Map();
    this.sessions = new Map();
    ws.addEventListener("message", (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && this.pending.has(msg.id)) {
        const { resolve, reject } = this.pending.get(msg.id);
        this.pending.delete(msg.id);
        if (msg.error) reject(new Error(JSON.stringify(msg.error)));
        else resolve(msg.result);
      }
    });
  }
  send(method, params = {}, sessionId) {
    const id = ++this.id;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error("timeout " + method));
        }
      }, 60000);
    });
  }
  async evaluate(expression, sessionId) {
    const r = await this.send(
      "Runtime.evaluate",
      { expression, awaitPromise: true, returnByValue: true },
      sessionId,
    );
    if (r.exceptionDetails) {
      throw new Error("eval error: " + JSON.stringify(r.exceptionDetails).slice(0, 500));
    }
    return r.result ? r.result.value : undefined;
  }
}

async function connect(wsUrl) {
  const ws = new WebSocket(wsUrl);
  await new Promise((res, rej) => {
    ws.addEventListener("open", res, { once: true });
    ws.addEventListener("error", rej, { once: true });
  });
  return new CDP(ws);
}

async function newPage(url) {
  // Target.createTarget (not /json/new): only this path gives the tab the
  // extension's own chrome.* APIs.
  const t = await cdp.send("Target.createTarget", { url });
  return { id: t.targetId };
}

let cdp = null;
try {
  const ver = await waitForDevtools();
  console.log("devtools:", ver["Browser"], "| headless:", HEADLESS);
  cdp = await connect(ver.webSocketDebuggerUrl);
  await cdp.send("Target.setDiscoverTargets", { discover: true });

  // Chrome 137+ ignores --load-extension; the DevTools command works.
  let extId = null;
  try {
    const res = await cdp.send("Extensions.loadUnpacked", { path: extPath });
    extId = res.id;
    console.log("Extensions.loadUnpacked ->", extId);
  } catch (e) {
    console.log("Extensions.loadUnpacked failed:", e.message.slice(0, 200));
  }
  if (!extId) {
    for (let i = 0; i < 40 && !extId; i++) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      const sw = targetInfos.find(
        (t) => t.url && t.url.startsWith("chrome-extension://") && t.url.includes("background.js"),
      );
      if (sw) extId = new URL(sw.url).host;
      else await sleep(500);
    }
  }
  if (!extId) {
    const { targetInfos } = await cdp.send("Target.getTargets");
    console.log("targets:", targetInfos.map((t) => t.type + " " + t.url.slice(0, 80)).join("\n  "));
    throw new Error("extension never loaded");
  }
  console.log("extension id:", extId);
  await sleep(1500);

  // An MV3 worker is lazy: open the extension page (it wakes the worker) and
  // prefer the page context, which also has chrome.storage and chrome.scripting.
  let extSess = null;
  try {
    const extPage = await newPage(`chrome-extension://${extId}/popup.html`);
    const { sessionId } = await cdp.send("Target.attachToTarget", { targetId: extPage.id, flatten: true });
    await cdp.send("Runtime.enable", {}, sessionId);
    for (let i = 0; i < 20 && !extSess; i++) {
      await sleep(700);
      const has = await cdp.evaluate(
        "typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.scripting && !!chrome.tabs",
        sessionId,
      );
      if (has === true) {
        extSess = sessionId;
        console.log("extension page context ready (chrome.storage + chrome.scripting)");
      }
    }
    if (!extSess) console.log("extension page has no chrome APIs after 20 tries");
  } catch (e) {
    console.log("ext page attempt:", e.message.slice(0, 140));
  }

  // fallback: the service worker target (wake it first)
  let wsid = extSess;
  if (!wsid) {
    let swTarget = null;
    for (let i = 0; i < 30 && !swTarget; i++) {
      const { targetInfos } = await cdp.send("Target.getTargets");
      swTarget = targetInfos.find(
        (t) => t.type === "service_worker" && t.url && t.url.includes(`${extId}/background.js`),
      );
      if (!swTarget) await sleep(500);
    }
    if (!swTarget) throw new Error("no extension context available (neither page nor worker)");
    const r = await cdp.send("Target.attachToTarget", { targetId: swTarget.targetId, flatten: true });
    wsid = r.sessionId;
    console.log("service worker attached:", swTarget.url);
  }

  // demo article
  const page = await newPage(DEMO);
  const { sessionId: psid } = await cdp.send("Target.attachToTarget", { targetId: page.id, flatten: true });
  await cdp.send("Page.enable", {}, psid);
  await cdp.send("Runtime.enable", {}, psid);
  await sleep(3000);
  console.log("demo title:", await cdp.evaluate("document.title", psid));

  // store the key (test only) and inject the content script
  // NOTE: the extension deliberately has no "tabs" permission, so tab URLs are
  // not visible here. We identify the demo tab by position instead: the demo
  // tab is the last one created and is not this extension page.
  const setup = await cdp.evaluate(
    `(async () => {
       await chrome.storage.local.set({ stretchKey: { accessToken: ${JSON.stringify(KEY)}, connectedAt: Date.now(), expiresAt: null } });
       const self = await chrome.tabs.getCurrent();
       const tabs = (await chrome.tabs.query({})).filter(t => t.id !== (self && self.id));
       if (!tabs.length) return "no candidate tab";
       const target = tabs[tabs.length - 1];
       await chrome.scripting.executeScript({ target: { tabId: target.id }, files: ["content.js"] });
       return "injected into tab " + target.id + " (index " + target.index + ")";
     })()`,
    wsid,
  );
  console.log("setup:", setup);

  // select a phrase the way a reader would
  const sel = await cdp.evaluate(
    `(() => {
       const p = [...document.querySelectorAll("p")].find(p => p.textContent.includes("Carthage was founded"));
       const node = [...p.childNodes].find(n => n.nodeType === 3 && n.textContent.includes("Carthage"));
       const text = node.textContent;
       const start = text.indexOf("Carthage");
       const r = document.createRange();
       r.setStart(node, start);
       r.setEnd(node, start + "Carthage".length);
       const s = window.getSelection();
       s.removeAllRanges();
       s.addRange(r);
       document.dispatchEvent(new Event("selectionchange"));
       return { selected: s.toString() };
     })()`,
    psid,
  );
  console.log("selection:", JSON.stringify(sel));
  await sleep(1200);

  // click the floating button where it actually is
  const btn = await cdp.evaluate(
    `(() => {
       const hosts = [...document.querySelectorAll("div")].filter(d => d.style && d.style.position === "fixed" && d.shadowRoot);
       if (!hosts.length) return null;
       const b = hosts[hosts.length - 1].getBoundingClientRect();
       return { x: b.left + b.width / 2, y: b.top + b.height / 2, text: hosts[hosts.length - 1].shadowRoot.textContent.trim() };
     })()`,
    psid,
  );
  console.log("stretch button:", JSON.stringify(btn));
  if (!btn) throw new Error("the Stretch button never appeared");

  await cdp.send("Input.dispatchMouseEvent", { type: "mousePressed", x: btn.x, y: btn.y, button: "left", clickCount: 1 }, psid);
  await cdp.send("Input.dispatchMouseEvent", { type: "mouseReleased", x: btn.x, y: btn.y, button: "left", clickCount: 1 }, psid);

  // wait for the model
  let state = null;
  for (let i = 0; i < 70; i++) {
    await sleep(1000);
    state = await cdp.evaluate(
      `(() => {
         const hosts = [...document.querySelectorAll("[data-stretch-host]")];
         if (!hosts.length) return { ready: false };
         const sh = hosts[0].shadowRoot;
         const add = sh.querySelector(".add");
         const err = sh.querySelector(".err");
         const load = sh.querySelector(".loading");
         return { ready: true,
                  cls: add ? "added" : (err ? "error" : (load ? "loading" : "pending")),
                  text: (add || err || load || {}).textContent || "" };
       })()`,
      psid,
    );
    if (state.ready && (state.cls === "added" || state.cls === "error")) break;
  }
  console.log("result:", JSON.stringify(state));

  await sleep(500);
  const shot = await cdp.send("Page.captureScreenshot", { format: "png" }, psid);
  fs.writeFileSync(OUT, Buffer.from(shot.data, "base64"));
  console.log("screenshot:", OUT, fs.statSync(OUT).size, "bytes");
} catch (e) {
  console.error("FAILED:", e.message);
  console.error(chromeLog.slice(-1200));
  process.exitCode = 1;
} finally {
  if (cdp) try { cdp.ws.close(); } catch (e) {}
  chrome.kill();
}
