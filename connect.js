/**
 * connect.js — the device-flow sign-in tab.
 *
 * The service worker owns the key. This page only shows the code, opens the
 * authorization page, and asks the worker to poll until the user approves.
 * A dedicated tab is the scheduler: an MV3 service worker can be suspended
 * at any time, so it must not be the one keeping time.
 */
const $ = (id) => document.getElementById(id);

let timer = null;
let state = { interval: 5, expiresAt: 0, userCode: "", verificationUriComplete: "", verificationUri: "" };
let polling = false;

function showError(msg) {
  const el = $("err");
  el.textContent = msg;
  el.classList.remove("hide");
}

function clearError() {
  $("err").classList.add("hide");
}

async function start() {
  clearError();
  $("start").disabled = true;
  $("start").textContent = "Requesting…";
  let res = null;
  try {
    res = await chrome.runtime.sendMessage({ v: 1, type: "DEVICE_CODE" });
  } catch (e) {
    res = null;
  }
  if (!res || !res.ok) {
    $("start").disabled = false;
    $("start").textContent = "Get a sign-in code";
    showError((res && res.error && res.error.message) || "Could not reach the background worker.");
    return;
  }
  state = {
    interval: Math.max(5, res.interval || 5),
    expiresAt: Date.now() + (res.expiresIn || 1800) * 1000,
    userCode: res.userCode || "",
    verificationUriComplete: res.verificationUriComplete || "",
    verificationUri: res.verificationUri || "",
  };
  $("code").textContent = state.userCode || "· · · ·";
  $("step1").classList.add("hide");
  $("step2").classList.remove("hide");
  $("authorize").disabled = !state.verificationUriComplete && !state.verificationUri;
  startCountdown();
  schedulePoll(0);
}

function startCountdown() {
  clearInterval(timer);
  timer = setInterval(() => {
    const left = Math.max(0, Math.round((state.expiresAt - Date.now()) / 1000));
    $("countdown").textContent = left > 0 ? `expires in ${Math.floor(left / 60)}:${String(left % 60).padStart(2, "0")}` : "expired";
    if (left <= 0) {
      clearInterval(timer);
      showError("The sign-in request expired. Start again.");
    }
  }, 1000);
}

function schedulePoll(delayMs) {
  clearTimeout(timer2);
  timer2 = setTimeout(poll, delayMs);
}

let timer2 = null;

async function poll() {
  if (polling) return;
  polling = true;
  try {
    const res = await chrome.runtime.sendMessage({ v: 1, type: "DEVICE_TOKEN" });
    if (res && res.ok) {
      clearInterval(timer);
      clearTimeout(timer2);
      $("step2").classList.add("hide");
      $("step3").classList.remove("hide");
      $("done").textContent = "✓ Connected to Pollinations.";
      return;
    }
    if (res && res.pending) {
      schedulePoll(state.interval * 1000);
      return;
    }
    const code = (res && res.error && res.error.code) || "";
    if (code === "OFFLINE" || code === "PROVIDER_ERROR") {
      // a transient failure must not end the sign-in: retry until it expires
      if (Date.now() < state.expiresAt) {
        showError("Still trying to reach Pollinations…");
        schedulePoll(Math.max(state.interval, 8) * 1000);
        return;
      }
    }
    showError((res && res.error && res.error.message) || "Sign-in did not complete.");
    $("start").disabled = false;
    $("start").textContent = "Start again";
    $("step2").classList.add("hide");
    $("step1").classList.remove("hide");
  } catch (e) {
    if (Date.now() < state.expiresAt) {
      schedulePoll(Math.max(state.interval, 8) * 1000);
      return;
    }
    showError("Could not reach the background worker.");
  } finally {
    polling = false;
  }
}

$("start").addEventListener("click", start);

$("authorize").addEventListener("click", () => {
  const url = state.verificationUriComplete || state.verificationUri;
  if (url) chrome.tabs.create({ url });
});

$("copy").addEventListener("click", async () => {
  try {
    await navigator.clipboard.writeText(state.userCode);
    $("copy").textContent = "Copied";
    setTimeout(() => ($("copy").textContent = "Copy code"), 1500);
  } catch (e) {
    showError("Could not copy. Select the code and copy it manually.");
  }
});

$("close").addEventListener("click", () => window.close());
