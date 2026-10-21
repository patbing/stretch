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
  byteLength,
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
const ELIGIBILITY_STORAGE = "stretchEligible";
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
  const got = await chrome.storage.local.get([MODEL_STORAGE, ELIGIBILITY_STORAGE]);
  const m = got && got[MODEL_STORAGE];
  const eligible = (got && got[ELIGIBILITY_STORAGE]) || null;
  const list = eligible && Array.isArray(eligible.models) ? eligible.models : null;
  if (list) {
    // The live catalogue is the authority: with no Quest-eligible model there is
    // nothing we may call. Never fall back to a model we were told is unusable.
    if (!list.length) return null;
    if (ALLOWED_MODELS.includes(m) && list.includes(m)) return m;
    return list[0];
  }
  // No successful discovery yet: fail closed rather than call blind.
  if (eligible && eligible.checked) return null;
  return null;
}

/** Models the live catalogue confirms as usable with Quest (tier) Pollen. */
async function getEligible() {
  const got = await chrome.storage.local.get(ELIGIBILITY_STORAGE);
  return (got && got[ELIGIBILITY_STORAGE]) || null;
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
  const eligibleModels = [];
  for (const id of ALLOWED_MODELS) {
    const m = items.find((x) => x && x.id === id);
    if (!m) continue; // not in the catalogue: not offered
    if (m.paid_only !== false) continue; // only an explicit paid_only:false is usable
    const p = m.pricing || {};
    const inRate = Number(p.promptTextTokens);
    const outRate = Number(p.completionTextTokens);
    if (Number.isFinite(inRate) && Number.isFinite(outRate)) {
      next[id] = { promptTextTokens: inRate, completionTextTokens: outRate };
    }
    eligibleModels.push(id);
  }
  await setPricing(next);
  await chrome.storage.local.set({
    [ELIGIBILITY_STORAGE]: { models: eligibleModels, checked: true, checkedAt: Date.now() },
  });
  return { ok: true, pricing: next, eligible: eligibleModels };
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
  const usedModel = model || null;
  if (!usedModel) {
    return fail(
      "NO_ELIGIBLE_MODEL",
      "No Quest-Pollen eligible model is available right now. Try again later.",
    );
  }

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

  // The serialized user message must stay inside the documented budget.
  if (byteLength(body.messages[1].content) > LIMITS.userMessageMaxBytes) {
    return fail("UNSUPPORTED_SELECTION", "The selected context is too long to send.");
  }

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
      // the caller distinguishes a timeout from a user cancel
      const timedOut = typeof deps.timedOut === "function" ? deps.timedOut() : !!deps.timedOut;
      return fail(timedOut ? "TIMEOUT" : "CANCELLED", timedOut
        ? "The model took too long. Try a shorter selection."
        : "Cancelled.");
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
    const mapped = mapUpstreamError(res.status, text, res.headers || {});
    // Only an explicit auth rejection clears the stored credential; a balance
    // problem must keep the connection.
    if (mapped.code === "AUTH_REJECTED") {
      try {
        await chrome.storage.local.remove([KEY_STORAGE]);
      } catch (e) {
        /* ignore */
      }
    }
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

export async function handleDeviceCode({ fetchImpl = fetch, sessionId = "" } = {}) {
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
      sessionId: sessionId || "",
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

export async function handleDeviceToken({ fetchImpl = fetch, sessionId = "" } = {}) {
  const got = await chrome.storage.session.get(SESSION_STORAGE);
  const session = (got && got[SESSION_STORAGE]) || null;
  if (!session || !session.deviceCode) {
    return fail("AUTH_REQUIRED", "Start the sign-in flow first.");
  }
  // A device session belongs to the tab that started it.
  if (session.sessionId && sessionId && session.sessionId !== sessionId) {
    return fail("AUTH_REJECTED", "This sign-in request belongs to another tab.");
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
    // Confirm the model catalogue before the reader can spend anything, so the
    // eligibility of the model we will call is known.
    const priced = await refreshPricing({ token: data.access_token }).catch(() => null);
    if (!priced || !priced.ok) {
      // keep the key, but say the model list could not be confirmed
      return { ok: true, pricingKnown: false };
    }
    return { ok: true, pricingKnown: true };
  }
  const err = (data && data.error) || "";
  if (err === "authorization_pending" || err === "slow_down") {
    if (err === "slow_down") {
      // back off as the provider asks
      session.interval = Math.min(30, (session.interval || 5) + 5);
      await chrome.storage.session.set({ [SESSION_STORAGE]: session });
    }
    return {
      ok: false,
      pending: true,
      interval: session.interval || 5,
      error: { code: "PENDING", message: "Waiting for approval." },
    };
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
  const eligible = await getEligible();
  const cost = model
    ? estimateCost({ model, promptTokens: 1500, completionTokens: 400, pricing })
    : null;
  return {
    ok: true,
    connected: !!token,
    model,
    models: ALLOWED_MODELS,
    eligible: (eligible && eligible.models) || null,
    typicalPollen: cost ? cost.typical : null,
    heavyPollen: cost ? cost.heavy : null,
  };
}

/* --------------------------------------------------------------- messaging */

/** Which message types may only come from a content script in a web page. */
const CONTENT_ONLY = new Set(["STRETCH_REQUEST", "STRETCH_CANCEL"]);
/** Which message types may only come from an extension page (popup/connect). */
const PRIVILEGED_ONLY = new Set(["DEVICE_CODE", "DEVICE_TOKEN", "DISCONNECT", "SET_MODEL", "REFRESH_PRICING", "ACTIVATE_TAB"]);

function senderIsContentScript(sender) {
  if (!sender) return false;
  // the sender must be this extension, and must say so
  if (!chrome.runtime || !chrome.runtime.id) return false;
  if (sender.id !== chrome.runtime.id) return false;
  if (!sender.tab || !sender.tab.id) return false;
  if (typeof sender.frameId === "number" && sender.frameId !== 0) return false; // top frame only
  const url = sender.url || "";
  if (url.startsWith("chrome-extension://")) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  return true;
}

function senderIsExtensionPage(sender) {
  if (!sender) return false;
  if (!chrome.runtime || !chrome.runtime.id) return false;
  if (sender.id !== chrome.runtime.id) return false;
  const url = sender.url || "";
  if (!url.startsWith(`chrome-extension://${chrome.runtime.id}/`)) return false;
  return true;
}

export async function dispatch(msg, sender) {
  if (!msg || typeof msg.type !== "string") {
    return fail("PROVIDER_ERROR", "Unknown message.");
  }
  if (typeof msg.v !== "number" || msg.v !== 1) {
    return fail("PROVIDER_ERROR", "Unsupported message version.");
  }
  // Sender boundary: a page may not ask for a generation on behalf of another
  // tab, and only our own extension pages may drive the privileged commands.
  if (CONTENT_ONLY.has(msg.type) && !senderIsContentScript(sender)) {
    return fail("UNSUPPORTED_SELECTION", "This request may only come from a page.");
  }
  if (PRIVILEGED_ONLY.has(msg.type) && !senderIsExtensionPage(sender)) {
    return fail("UNSUPPORTED_SELECTION", "This command may only come from the extension.");
  }
  // A status read is harmless, but it still comes from this extension only.
  if (msg.type === "STRETCH_STATUS" && !senderIsContentScript(sender) && !senderIsExtensionPage(sender)) {
    return fail("UNSUPPORTED_SELECTION", "This request may only come from STRETCH.");
  }
  switch (msg.type) {
    case "STRETCH_REQUEST": {
      // Never touch a credential while the storage guard is not in place.
      await guardStorage();
      if (!storageGuarded) {
        return fail(
          "PROVIDER_ERROR",
          "STRETCH could not protect its stored key, so it will not call the model.",
        );
      }
      // Register the request BEFORE awaiting anything, so a cancel that arrives
      // during the storage reads still finds it.
      const controller = new AbortController();
      const tabId = sender && sender.tab ? sender.tab.id : 0;
      const key = `${msg.requestId || ""}:${tabId}`;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        controller.abort();
      }, LIMITS.requestTimeoutMs);
      inFlight.set(key, controller);
      try {
        const token = await getKey();
        const model = await getModel();
        const pricing = await getPricing();
        // the worker owns the model: ignore any model the page may have sent
        const res = await handleStretchRequest(
          { ...msg, model: undefined },
          { token, model, pricing, signal: controller.signal, timedOut: () => timedOut },
        );
        return { v: 1, type: "STRETCH_RESULT", requestId: msg.requestId, anchorId: msg.anchorId, ...res };
      } finally {
        clearTimeout(timer);
        // only delete our own entry: a newer request with the same id must survive
        if (inFlight.get(key) === controller) inFlight.delete(key);
      }
    }
    case "STRETCH_CANCEL": {
      // cancel only this request in this tab
      const tabId = sender && sender.tab ? sender.tab.id : 0;
      const key = `${msg.requestId || ""}:${tabId}`;
      const c = inFlight.get(key);
      if (c) c.abort();
      return { v: 1, type: "STRETCH_CANCELLED", requestId: msg.requestId };
    }
    case "STRETCH_STATUS":
      return await handleStatus();
    case "DEVICE_CODE":
      return await handleDeviceCode({ sessionId: msg.sessionId || "" });
    case "DEVICE_TOKEN":
      return await handleDeviceToken({ sessionId: msg.sessionId || "" });
    case "DISCONNECT": {
      await chrome.storage.local.remove([KEY_STORAGE]);
      await chrome.storage.session.remove(SESSION_STORAGE);
      return { ok: true };
    }
    case "SET_MODEL": {
      if (!ALLOWED_MODELS.includes(msg.model)) {
        return fail("PROVIDER_ERROR", "Unsupported model.");
      }
      // never select a model the live catalogue says is not usable with Quest Pollen
      const eligible = await getEligible();
      if (eligible && Array.isArray(eligible.models) && !eligible.models.includes(msg.model)) {
        return fail(
          "NO_ELIGIBLE_MODEL",
          "That model is not available with Quest Pollen right now.",
        );
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

// The Pollinations key must not be readable by content scripts.
// chrome.storage.local is exposed to content scripts by default, so restrict it.
// The listener is registered synchronously (a worker must not miss the message
// that woke it); dispatch refuses secret operations if the guard failed.
let storageGuarded = false;
let storageGuardPromise = null;
function guardStorage() {
  if (storageGuardPromise) return storageGuardPromise;
  storageGuardPromise = (async () => {
    try {
      if (chrome.storage && chrome.storage.local && chrome.storage.local.setAccessLevel) {
        await chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      }
      if (chrome.storage && chrome.storage.session && chrome.storage.session.setAccessLevel) {
        await chrome.storage.session.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
      }
      storageGuarded = true;
    } catch (e) {
      storageGuarded = false;
    }
    return storageGuarded;
  })();
  return storageGuardPromise;
}
guardStorage();

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
