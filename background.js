/**
 * background.js — the service worker.
 *
 * It owns the reader's Pollinations key and every call to the Pollinations API.
 * The content script never sees a credential: it sends a bounded text request
 * and receives text, a status and a cost estimate.
 *
 * Message contract (v1):
 *   content -> worker : STRETCH_REQUEST, STRETCH_CANCEL, STRETCH_STATUS
 *   popup   -> worker : STRETCH_STATUS, DEVICE_CODE, DEVICE_TOKEN, DISCONNECT,
 *                       SET_MODEL, REFRESH_PRICING, ACTIVATE_TAB
 *   worker  -> content: STRETCH_RESULT
 */
import { SYSTEM_PROMPT, buildUserMessage } from "./lib/prompt.js";
import {
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  LIMITS,
  REFERENCE_PRICING,
  estimateCost,
  mapUpstreamError,
  validateOutput,
  validateRequest,
} from "./lib/validate.js";

const API_BASE = "https://gen.pollinations.ai";
const ENTER_BASE = "https://enter.pollinations.ai";
const MODELS_URL = `${API_BASE}/v1/models`;
const CHAT_URL = `${API_BASE}/v1/chat/completions`;
const DEVICE_CODE_URL = `${ENTER_BASE}/api/device/code`;
const DEVICE_TOKEN_URL = `${ENTER_BASE}/api/device/token`;

const KEY_STORAGE = "stretchKey";
const MODEL_STORAGE = "stretchModel";
const PRICING_STORAGE = "stretchPricing";
const SESSION_STORAGE = "stretchSession";

/** In-flight requests, so we can cancel them per tab. */
const inFlight = new Map();

/* ------------------------------------------------------------------ storage */

async function getKey() {
  const got = await chrome.storage.local.get(KEY_STORAGE);
  const rec = got && got[KEY_STORAGE];
  return rec && rec.accessToken ? rec.accessToken : null;
}

async function getKeyRecord() {
  const got = await chrome.storage.local.get(KEY_STORAGE);
  return (got && got[KEY_STORAGE]) || null;
}

async function getModel() {
  const got = await chrome.storage.local.get(MODEL_STORAGE);
  const m = got && got[MODEL_STORAGE];
  return ALLOWED_MODELS.includes(m) ? m : DEFAULT_MODEL;
}

async function getPricing() {
  const got = await chrome.storage.local.get(PRICING_STORAGE);
  return (got && got[PRICING_STORAGE]) || { ...REFERENCE_PRICING };
}

async function setPricing(pricing) {
  await chrome.storage.local.set({ [PRICING_STORAGE]: pricing });
}

/* -------------------------------------------------------------- model sheet */

export async function refreshPricing({ fetchImpl = fetch, token } = {}) {
  if (!token) return { ok: false, error: { code: "AUTH_REQUIRED", message: "Not connected." } };
  let data;
  try {
    const res = await fetchImpl(MODELS_URL, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return { ok: false, error: { code: "PROVIDER_ERROR", message: "Model list unavailable." } };
    data = await res.json();
  } catch (e) {
    return { ok: false, error: { code: "OFFLINE", message: "Offline." } };
  }
  const items = (data && data.data) || [];
  const next = { ...REFERENCE_PRICING };
  for (const id of ALLOWED_MODELS) {
    const m = items.find((x) => x && x.id === id);
    if (!m) continue;
    if (m.paid_only === true) continue; // never surface a paid-only model
    const p = m.pricing || {};
    const inRate = Number(p.promptTextTokens);
    const outRate = Number(p.completionTextTokens);
    if (Number.isFinite(inRate) && Number.isFinite(outRate)) {
      next[id] = { promptTextTokens: inRate, completionTextTokens: outRate };
    }
  }
  await setPricing(next);
  return { ok: true, pricing: next };
}

/* ------------------------------------------------------------- generation */

export async function handleStretchRequest(payload, deps = {}) {
  const {
    fetchImpl = fetch,
    token = null,
    model = DEFAULT_MODEL,
    pricing = REFERENCE_PRICING,
    signal = null,
  } = deps;

  const checked = validateRequest(payload);
  if (!checked.ok) return checked;
  const req = checked.request;

  // The worker owns the model: a content script may not choose one.
  const usedModel = model || DEFAULT_MODEL;

  if (!token) {
    return fail("AUTH_REQUIRED", "Connect your Pollen account in STRETCH.");
  }

  const body = {
    model: usedModel,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage(req) },
    ],
    max_tokens: LIMITS.maxTokens,
    stream: false,
  };

  let res;
  try {
    res = await fetchImpl(CHAT_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: signal || undefined,
    });
  } catch (e) {
    if (e && e.name === "AbortError") {
      return fail("CANCELLED", "Cancelled.");
    }
    return fail("OFFLINE", "Offline. Check your connection and try again.");
  }

  if (!res.ok) {
    let text = "";
    try {
      text = await res.text();
    } catch (_) {
      /* ignore */
    }
    const mapped = mapUpstreamError(res.status, text);
    return { ok: false, error: mapped };
  }

  let data;
  try {
    data = await res.json();
  } catch (e) {
    return fail("PROVIDER_ERROR", "The provider returned an unreadable answer.");
  }

  const choice = (data && data.choices && data.choices[0]) || {};
  const usage = (data && data.usage) || {};
  const validated = validateOutput(choice.message && choice.message.content, {
    finishReason: choice.finish_reason,
  });
  if (!validated.ok) return validated;

  const cost = estimateCost({
    model: usedModel,
    promptTokens: usage.prompt_tokens,
    completionTokens: usage.completion_tokens,
    pricing,
  });

  return {
    ok: true,
    body: validated.text,
    model: usedModel,
    usage: {
      promptTokens: usage.prompt_tokens || 0,
      completionTokens: usage.completion_tokens || 0,
    },
    estimatedPollen: cost ? cost.pollen : null,
  };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/* ------------------------------------------------------------ device flow */

export async function handleDeviceCode({ fetchImpl = fetch } = {}) {
  let res;
  try {
    res = await fetchImpl(DEVICE_CODE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return fail("OFFLINE", "Offline. Check your connection and try again.");
  }
  if (!res.ok) return fail("PROVIDER_ERROR", "Could not start the sign-in flow.");
  let data;
  try {
    data = await res.json();
  } catch (e) {
    return fail("PROVIDER_ERROR", "Unreadable response from Pollinations.");
  }
  if (!data || !data.device_code) {
    return fail("PROVIDER_ERROR", "Pollinations did not return a device code.");
  }
  await chrome.storage.session.set({
    [SESSION_STORAGE]: {
      deviceCode: data.device_code,
      interval: Number(data.interval) || 5,
      expiresAt: Date.now() + (Number(data.expires_in) || 1800) * 1000,
      startedAt: Date.now(),
    },
  });
  return {
    ok: true,
    deviceCode: data.device_code,
    userCode: data.user_code || "",
    verificationUri: data.verification_uri || "",
    verificationUriComplete: data.verification_uri_complete || "",
    interval: Number(data.interval) || 5,
    expiresIn: Number(data.expires_in) || 1800,
  };
}

export async function handleDeviceToken({ fetchImpl = fetch } = {}) {
  const got = await chrome.storage.session.get(SESSION_STORAGE);
  const session = (got && got[SESSION_STORAGE]) || null;
  if (!session || !session.deviceCode) {
    return fail("AUTH_REQUIRED", "Start the sign-in flow first.");
  }
  if (session.expiresAt && Date.now() > session.expiresAt) {
    await chrome.storage.session.remove(SESSION_STORAGE);
    return fail("AUTH_REJECTED", "The sign-in request expired. Start again.");
  }
  let res;
  try {
    res = await fetchImpl(DEVICE_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ device_code: session.deviceCode }),
      signal: AbortSignal.timeout(10000),
    });
  } catch (e) {
    return fail("OFFLINE", "Offline. Check your connection and try again.");
  }
  let data = {};
  try {
    data = await res.json();
  } catch (e) {
    data = {};
  }
  if (data && data.access_token) {
    await chrome.storage.local.set({
      [KEY_STORAGE]: { accessToken: data.access_token, connectedAt: Date.now(), expiresAt: null },
    });
    await chrome.storage.session.remove(SESSION_STORAGE);
    // Prices are a nicety: never make the sign-in wait for them.
    refreshPricing({ token: data.access_token }).catch(() => {});
    return { ok: true };
  }
  const err = (data && data.error) || "";
  if (err === "authorization_pending" || err === "slow_down") {
    return { ok: false, pending: true, error: { code: "PENDING", message: "Waiting for approval." } };
  }
  if (err === "expired_token" || err === "access_denied") {
    await chrome.storage.session.remove(SESSION_STORAGE);
    return fail("AUTH_REJECTED", "The sign-in request was denied or expired. Start again.");
  }
  return fail("AUTH_REJECTED", "Could not complete sign-in. Start again.");
}

/* ------------------------------------------------------------------ status */

export async function handleStatus() {
  const token = await getKey();
  const model = await getModel();
  const pricing = await getPricing();
  const cost = estimateCost({ model, promptTokens: 1500, completionTokens: 400, pricing });
  return {
    ok: true,
    connected: !!token,
    model,
    models: ALLOWED_MODELS,
    typicalPollen: cost ? cost.typical : null,
    heavyPollen: cost ? cost.heavy : null,
  };
}

/* --------------------------------------------------------------- messaging */

/** Which message types may only come from a content script in a web page. */
const CONTENT_ONLY = new Set(["STRETCH_REQUEST", "STRETCH_CANCEL"]);

function senderIsContentScript(sender) {
  if (!sender) return false;
  if (!sender.tab || !sender.tab.id) return false;
  const url = sender.url || "";
  // an extension page is not a content script
  if (url.startsWith("chrome-extension://")) return false;
  return true;
}

export async function dispatch(msg, sender) {
  if (!msg || typeof msg.type !== "string") {
    return fail("PROVIDER_ERROR", "Unknown message.");
  }
  // Sender boundary: a page may not ask for a generation on behalf of another
  // tab, and an extension page may not inject into pages it was not opened for.
  if (CONTENT_ONLY.has(msg.type) && !senderIsContentScript(sender)) {
    return fail("UNSUPPORTED_SELECTION", "This request may only come from a page.");
  }
  switch (msg.type) {
    case "STRETCH_REQUEST": {
      const token = await getKey();
      const model = await getModel();
      const pricing = await getPricing();
      const controller = new AbortController();
      const key = `${msg.requestId || ""}:${sender && sender.tab ? sender.tab.id : ""}`;
      const timer = setTimeout(() => controller.abort(), LIMITS.requestTimeoutMs);
      inFlight.set(key, controller);
      try {
        // the worker owns the model: ignore any model the page may have sent
        const res = await handleStretchRequest(
          { ...msg, model: undefined, requestId: msg.requestId, anchorId: msg.anchorId },
          { token, model, pricing, signal: controller.signal },
        );
        return { v: 1, type: "STRETCH_RESULT", requestId: msg.requestId, anchorId: msg.anchorId, ...res };
      } finally {
        clearTimeout(timer);
        inFlight.delete(key);
      }
    }
    case "STRETCH_CANCEL": {
      for (const [k, c] of inFlight) {
        if (k.startsWith(`${msg.requestId || ""}:`)) c.abort();
      }
      return { v: 1, type: "STRETCH_CANCELLED", requestId: msg.requestId };
    }
    case "STRETCH_STATUS":
      return await handleStatus();
    case "DEVICE_CODE":
      return await handleDeviceCode();
    case "DEVICE_TOKEN":
      return await handleDeviceToken();
    case "DISCONNECT": {
      await chrome.storage.local.remove([KEY_STORAGE]);
      await chrome.storage.session.remove(SESSION_STORAGE);
      return { ok: true };
    }
    case "SET_MODEL": {
      if (!ALLOWED_MODELS.includes(msg.model)) {
        return fail("PROVIDER_ERROR", "Unsupported model.");
      }
      await chrome.storage.local.set({ [MODEL_STORAGE]: msg.model });
      const token = await getKey();
      if (token) refreshPricing({ token }).catch(() => {});
      return { ok: true, model: msg.model };
    }
    case "REFRESH_PRICING": {
      const token = await getKey();
      return await refreshPricing({ token });
    }
    case "ACTIVATE_TAB": {
      const tabId = msg.tabId;
      if (!tabId) return fail("UNSUPPORTED_SELECTION", "No tab.");
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        return { ok: true };
      } catch (e) {
        return fail("UNSUPPORTED_SELECTION", "This page does not allow extensions.");
      }
    }
    default:
      return { ok: false, error: { code: "PROVIDER_ERROR", message: "Unknown message." } };
  }
}

if (typeof chrome !== "undefined" && chrome.runtime && chrome.runtime.onMessage) {
  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    dispatch(msg, sender)
      .then((r) => sendResponse(r))
      .catch((e) =>
        sendResponse({ ok: false, error: { code: "PROVIDER_ERROR", message: String(e && e.message) } }),
      );
    return true; // async response
  });
}

// The Pollinations key must not be readable by content scripts.
// chrome.storage.local is exposed to content scripts by default, so restrict it.
if (typeof chrome !== "undefined" && chrome.storage && chrome.storage.local) {
  try {
    chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (e) {
    /* older Chrome: ignore */
  }
  try {
    chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
  } catch (e) {
    /* ignore */
  }
}
