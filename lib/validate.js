/**
 * lib/validate.js — pure validation + cost math for STRETCH.
 *
 * No chrome.* APIs, no DOM: everything here is unit testable with node --test.
 */

export const LIMITS = {
  selectionMax: 600,     // Unicode code points
  contextMax: 1000,      // before / after, same paragraph
  userMessageMaxBytes: 6000,
  outputMax: 1200,       // code points of the generated body
  outputPreferredWords: [20, 60],
  outputHardWords: 90,
  requestTimeoutMs: 30000,
  // Reasoning models spend the budget on thinking before writing the answer:
  // at 400 the content came back empty with finish_reason "length".
  maxTokens: 1200,
};

/**
 * The only models this extension will ever call.
 * Both are tier eligible (paid_only:false) so a reader with only Quest Pollen
 * can use them. Measured 2026-10-22 on the real prompt: gpt-5.4-nano answers
 * in ~2-8s and never truncates; deepseek-v4.1-flash is slower (9-22s) because
 * it reasons first, but writes the most fluent expansion.
 */
export const ALLOWED_MODELS = ["openai/gpt-5.4-nano", "deepseek/deepseek-v4.1-flash"];
export const DEFAULT_MODEL = "openai/gpt-5.4-nano";

/** Reference prices (pollen per token) as of 2026-10-22, from GET /v1/models. */
export const REFERENCE_PRICING = {
  "openai/gpt-5.4-nano": {
    promptTextTokens: 0.00000015,
    completionTextTokens: 0.0000009375,
  },
  "deepseek/deepseek-v4.1-flash": {
    promptTextTokens: 0.00000015,
    completionTextTokens: 0.0000006,
  },
};

export const MODEL_LABELS = {
  "openai/gpt-5.4-nano": "Nano (default)",
  "deepseek/deepseek-v4.1-flash": "Flash (slower, richer)",
};

/** Count Unicode code points (not UTF-16 units). */
export function codePointLength(s) {
  return Array.from(String(s ?? "")).length;
}

export function byteLength(s) {
  return new TextEncoder().encode(String(s ?? "")).length;
}

/**
 * Validate an inbound request from the content script.
 * Returns { ok: true, request } or { ok: false, error: { code, message } }.
 */
export function validateRequest(req) {
  if (!req || typeof req !== "object") {
    return fail("UNSUPPORTED_SELECTION", "Malformed request.");
  }
  const { selection, before, after, model } = req;

  if (typeof selection !== "string" || !selection.trim()) {
    return fail("UNSUPPORTED_SELECTION", "Select some text first.");
  }
  const selLen = codePointLength(selection);
  if (selLen > LIMITS.selectionMax) {
    return fail(
      "UNSUPPORTED_SELECTION",
      `Selections longer than ${LIMITS.selectionMax} characters are not supported.`,
    );
  }
  if (typeof before !== "string" || typeof after !== "string") {
    return fail("UNSUPPORTED_SELECTION", "Missing paragraph context.");
  }
  if (codePointLength(before) > LIMITS.contextMax || codePointLength(after) > LIMITS.contextMax) {
    return fail("UNSUPPORTED_SELECTION", "Selection context is too long.");
  }
  const usedModel = model || DEFAULT_MODEL;
  if (!ALLOWED_MODELS.includes(usedModel)) {
    return fail("PROVIDER_ERROR", "Unsupported model.");
  }
  return {
    ok: true,
    request: {
      selection,
      before,
      after,
      model: usedModel,
      requestId: req.requestId || "",
      anchorId: req.anchorId || "",
      documentId: req.documentId || "",
    },
  };
}

function fail(code, message) {
  return { ok: false, error: { code, message } };
}

/**
 * Validate the model's answer before it is ever shown.
 * Rejects empty output, over-long output, markdown fences and answer labels.
 */
export function validateOutput(raw, { finishReason } = {}) {
  if (typeof raw !== "string" || !raw.trim()) {
    return fail("BAD_OUTPUT", "The model returned nothing.");
  }
  if (finishReason === "length") {
    return fail("BAD_OUTPUT", "The answer was cut off. Try a shorter selection.");
  }
  let text = raw.trim();
  // strip a single outer pair of parentheses if the model added one
  const m = text.match(/^\(([\s\S]*)\)$/);
  if (m) text = m[1].trim();
  if (!text) return fail("BAD_OUTPUT", "The model returned nothing useful.");
  // a leading separator would read as broken punctuation once wrapped in parentheses
  text = text.replace(/^[,;:]\s*/, "").trim();
  if (!text) return fail("BAD_OUTPUT", "The model returned nothing useful.");
  if (codePointLength(text) > LIMITS.outputMax) {
    return fail("BAD_OUTPUT", "The answer was too long to insert inline.");
  }
  if (/^```/.test(text) || /^#{1,6}\s/m.test(text)) {
    return fail("BAD_OUTPUT", "The model returned formatted text instead of a plain addition.");
  }
  if (/^(answer|summary|explanation|response|note)\s*[:\-]/i.test(text)) {
    return fail("BAD_OUTPUT", "The model returned a labelled answer instead of an inline addition.");
  }
  if (/(^|\n)\s*[-*]\s+/m.test(text)) {
    return fail("BAD_OUTPUT", "The model returned a list instead of an inline addition.");
  }
  const words = text.split(/\s+/).filter(Boolean).length;
  if (words > LIMITS.outputHardWords) {
    return fail("BAD_OUTPUT", "The answer was too long to insert inline.");
  }
  return { ok: true, text, words };
}

/** Estimated pollen for a request, from the live pricing sheet or the reference. */
export function estimateCost({ model, promptTokens, completionTokens, pricing }) {
  const sheet = (pricing && pricing[model]) || REFERENCE_PRICING[model];
  if (!sheet) return null;
  const inRate = Number(sheet.promptTextTokens ?? 0);
  const outRate = Number(sheet.completionTextTokens ?? 0);
  const cost =
    (Number(promptTokens) || 0) * inRate + (Number(completionTokens) || 0) * outRate;
  return {
    pollen: cost,
    inRate,
    outRate,
    typical: (1500 * inRate) + (400 * outRate),
    heavy: (9000 * inRate) + (400 * outRate),
  };
}

/** Map an upstream HTTP status + body to our error codes. */
export function mapUpstreamError(status, bodyText) {
  const body = String(bodyText || "").toLowerCase();
  if (status === 401) {
    return { code: "AUTH_REJECTED", message: "That Pollen key was rejected. Reconnect your account." };
  }
  if (status === 403) {
    if (body.includes("insufficient") || body.includes("balance") || body.includes("pollen")) {
      return { code: "BALANCE_REQUIRED", message: "Not enough eligible Pollen. Manage your balance at Pollinations." };
    }
    return { code: "AUTH_REJECTED", message: "That Pollen key was rejected. Reconnect your account." };
  }
  if (status === 402) {
    return { code: "BALANCE_REQUIRED", message: "Not enough eligible Pollen. Manage your balance at Pollinations." };
  }
  if (status === 429) {
    return { code: "RATE_LIMITED", message: "Rate limited. Try again in a moment." };
  }
  if (status === 402 || status === 400) {
    return { code: "PROVIDER_ERROR", message: "The request was rejected by the provider." };
  }
  return { code: "PROVIDER_ERROR", message: "The provider returned an error." };
}
