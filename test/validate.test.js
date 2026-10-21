import test from "node:test";
import assert from "node:assert/strict";
import {
  ALLOWED_MODELS,
  DEFAULT_MODEL,
  LIMITS,
  codePointLength,
  byteLength,
  estimateCost,
  mapUpstreamError,
  validateOutput,
  validateRequest,
} from "../lib/validate.js";
import { buildUserMessage, bracketsFor, detectLanguage } from "../lib/prompt.js";

const ok = (selection = "photosynthesis", extra = {}) =>
  validateRequest({
    selection,
    before: "Plants use ",
    after: " to produce sugars.",
    model: DEFAULT_MODEL,
    ...extra,
  });

test("codePointLength counts code points, not UTF-16 units", () => {
  assert.equal(codePointLength("abc"), 3);
  assert.equal(codePointLength("한글"), 2);
  assert.equal(codePointLength("😀"), 1);
});

test("byteLength counts UTF-8 bytes", () => {
  assert.equal(byteLength("abc"), 3);
  assert.equal(byteLength("한"), 3);
});

test("validateRequest accepts a normal selection", () => {
  const r = ok();
  assert.equal(r.ok, true);
  // the model is not part of the request any more: the worker owns it
  assert.equal(r.request.model, undefined);
  assert.equal(r.request.selection, "photosynthesis");
});

test("validateRequest rejects an empty selection", () => {
  const r = ok("   ");
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "UNSUPPORTED_SELECTION");
});

test("validateRequest rejects a selection over the limit", () => {
  const r = ok("x".repeat(LIMITS.selectionMax + 1));
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "UNSUPPORTED_SELECTION");
});

test("validateRequest ignores a model sent by the page (the worker owns it)", () => {
  const r = ok("x", { model: "evil/model" });
  assert.equal(r.ok, true);
  assert.equal(r.request.model, undefined);
});

test("validateRequest rejects context that is too long", () => {
  const r = ok("x", { before: "y".repeat(LIMITS.contextMax + 1) });
  assert.equal(r.ok, false);
});

test("validateOutput accepts a plain addition and strips one pair of parentheses", () => {
  const r = validateOutput("  (the process of converting light)  ");
  assert.equal(r.ok, true);
  assert.equal(r.text, "the process of converting light");
});

test("validateOutput rejects empty output", () => {
  assert.equal(validateOutput("").ok, false);
  assert.equal(validateOutput("   ").ok, false);
});

test("validateOutput rejects markdown fences and headings", () => {
  assert.equal(validateOutput("```js\ncode\n```").ok, false);
  assert.equal(validateOutput("## Heading\ntext").ok, false);
});

test("validateOutput rejects labelled answers and lists", () => {
  assert.equal(validateOutput("Answer: because of photosynthesis").ok, false);
  assert.equal(validateOutput("- one\n- two").ok, false);
});

test("validateOutput rejects truncated output", () => {
  const r = validateOutput("some text", { finishReason: "length" });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, "BAD_OUTPUT");
});

test("validateOutput rejects output that is too long", () => {
  const r = validateOutput("w ".repeat(LIMITS.outputHardWords + 20));
  assert.equal(r.ok, false);
});

test("estimateCost uses the reference prices", () => {
  const c = estimateCost({
    model: "deepseek/deepseek-v4.1-flash",
    promptTokens: 1500,
    completionTokens: 400,
  });
  assert.ok(c.pollen > 0);
  assert.ok(c.typical < 0.001, "a typical stretch must cost well under 0.001 pollen");
  assert.ok(c.heavy < 0.01);
});

test("mapUpstreamError separates auth, balance, rate limit and provider errors", () => {
  assert.equal(mapUpstreamError(401, "").code, "AUTH_REJECTED");
  assert.equal(mapUpstreamError(402, "").code, "BALANCE_REQUIRED");
  assert.equal(mapUpstreamError(403, "invalid api key").code, "AUTH_REJECTED");
  assert.equal(mapUpstreamError(403, "insufficient balance").code, "BALANCE_REQUIRED");
  assert.equal(mapUpstreamError(403, "forbidden").code, "PROVIDER_ERROR");
  assert.equal(mapUpstreamError(429, "").code, "RATE_LIMITED");
  assert.equal(mapUpstreamError(500, "").code, "PROVIDER_ERROR");
});

test("mapUpstreamError carries Retry-After through", () => {
  const r = mapUpstreamError(429, "", { "retry-after": "12" });
  assert.equal(r.code, "RATE_LIMITED");
  assert.equal(r.retryAfter, "12");
});

test("buildUserMessage produces valid JSON that cannot break out", () => {
  const msg = buildUserMessage({ selection: 'say "hi"', before: "a\nb", after: "c" });
  const parsed = JSON.parse(msg);
  assert.equal(parsed.selection, 'say "hi"');
  assert.equal(parsed.before, "a\nb");
});

test("language detection picks the bracket pair", () => {
  assert.deepEqual(bracketsFor("hello"), ["(", ")"]);
  assert.deepEqual(bracketsFor("한글"), ["(", ")"]);
  assert.deepEqual(bracketsFor("日本語"), ["（", "）"]);
  assert.equal(detectLanguage("hello"), "en");
});

test("allowed models are tier eligible", () => {
  assert.deepEqual(ALLOWED_MODELS, ["openai/gpt-5.4-nano", "deepseek/deepseek-v4.1-flash"]);
  assert.equal(DEFAULT_MODEL, "openai/gpt-5.4-nano");
});
