/**
 * popup.js — the toolbar popup.
 *
 * Owns nothing secret: it asks the service worker for status, chooses the
 * model, injects the content script into the active tab, and starts the
 * device-flow sign-in in a dedicated tab.
 */
import { ALLOWED_MODELS, MODEL_LABELS } from "./lib/validate.js";

const $ = (id) => document.getElementById(id);

function fmtPollen(v) {
  if (v === null || v === undefined) return "–";
  if (v < 0.001) return `${v.toFixed(7)} Pollen`;
  return `${v.toFixed(5)} Pollen`;
}

async function status() {
  try {
    return await chrome.runtime.sendMessage({ v: 1, type: "STRETCH_STATUS" });
  } catch (e) {
    return { ok: false, connected: false };
  }
}

async function render() {
  const s = await status();
  const el = $("status");
  if (!s || !s.ok) {
    el.className = "status warn";
    el.textContent = "STRETCH could not reach its background worker.";
    return;
  }
  $("model").value = s.model;
  // built with DOM nodes, never innerHTML
  el.replaceChildren();
  if (s.connected) {
    el.className = "status ok";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = "#22c55e";
    el.append(
      dot,
      document.createTextNode(
        "Connected. Authorized keys normally expire after 7 days and can be revoked sooner.",
      ),
    );
    $("connect").hidden = true;
    $("disconnect").hidden = false;
  } else {
    el.className = "status warn";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = "#d29922";
    el.append(dot, document.createTextNode("Not connected. Connect your Pollen to stretch."));
    $("connect").hidden = false;
    $("disconnect").hidden = true;
  }
  $("typical").textContent = fmtPollen(s.typicalPollen);
  $("cost").title = `Model: ${MODEL_LABELS[s.model] || s.model} (${s.model})`;
}

$("model").addEventListener("change", async (e) => {
  const model = e.target.value;
  if (!ALLOWED_MODELS.includes(model)) return;
  await chrome.runtime.sendMessage({ v: 1, type: "SET_MODEL", model });
  await render();
});

$("enable").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  const res = await chrome.runtime.sendMessage({ v: 1, type: "ACTIVATE_TAB", tabId: tab.id });
  if (res && res.ok) {
    $("enable").textContent = "Enabled — select text";
    setTimeout(() => window.close(), 600);
  } else {
    $("status").className = "status warn";
    $("status").textContent = (res && res.error && res.error.message) || "This page does not allow extensions.";
  }
});

$("remove").addEventListener("click", async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) return;
  try {
    await chrome.tabs.sendMessage(tab.id, { v: 1, type: "STRETCH_REMOVE_ALL" });
    $("remove").textContent = "Removed";
    setTimeout(() => window.close(), 500);
  } catch (e) {
    $("remove").textContent = "Not active here";
  }
});

$("connect").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("connect.html") });
  window.close();
});

$("disconnect").addEventListener("click", async () => {
  const ok = window.confirm(
    "This disconnects STRETCH locally. Revoke the key at Pollinations to invalidate it everywhere.\n\nDisconnect now?",
  );
  if (!ok) return;
  await chrome.runtime.sendMessage({ v: 1, type: "DISCONNECT" });
  await render();
});

render();
setInterval(render, 4000);
