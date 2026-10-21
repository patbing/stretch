import test from "node:test";
import assert from "node:assert/strict";

/** Minimal chrome.storage mock so the service worker logic can run under node. */
function installChromeMock() {
  const local = {};
  const session = {};
  globalThis.chrome = {
    storage: {
      local: {
        async get(keys) {
          const want = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          const out = {};
          for (const k of want) if (k in local) out[k] = local[k];
          return out;
        },
        async set(obj) {
          Object.assign(local, obj);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete local[k];
        },
      },
      session: {
        async get(keys) {
          const want = Array.isArray(keys) ? keys : typeof keys === "string" ? [keys] : Object.keys(keys || {});
          const out = {};
          for (const k of want) if (k in session) out[k] = session[k];
          return out;
        },
        async set(obj) {
          Object.assign(session, obj);
        },
        async remove(keys) {
          for (const k of Array.isArray(keys) ? keys : [keys]) delete session[k];
        },
      },
    },
  };
  return { local, session };
}

installChromeMock();
const { handleStretchRequest, refreshPricing, handleDeviceCode, handleDeviceToken, handleStatus } =
  await import("../background.js");

const REQ = {
  selection: "photosynthesis",
  before: "Plants use ",
  after: " to produce sugars.",
  requestId: "r1",
  anchorId: "a1",
};

function fakeFetch(handler) {
  return async (url, opts) => handler(url, opts);
}

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return body;
    },
    async text() {
      return JSON.stringify(body);
    },
  };
}

test("a successful request returns the body, usage and a cost estimate", async () => {
  const res = await handleStretchRequest(REQ, {
    token: "sk_test",
    model: "deepseek/deepseek-v4.1-flash",
    fetchImpl: fakeFetch(async () =>
      jsonResponse({
        choices: [{ message: { content: "the process of converting light into sugars" }, finish_reason: "stop" }],
        usage: { prompt_tokens: 300, completion_tokens: 25 },
      }),
    ),
  });
  assert.equal(res.ok, true);
  assert.equal(res.body, "the process of converting light into sugars");
  assert.equal(res.usage.completionTokens, 25);
  assert.ok(res.estimatedPollen > 0);
});

test("the request never carries a page URL and always uses the allowlisted model", async () => {
  let seen = null;
  await handleStretchRequest(REQ, {
    token: "sk_test",
    model: "openai/gpt-5.4-nano",
    fetchImpl: fakeFetch(async (url, opts) => {
      seen = { url, body: JSON.parse(opts.body) };
      return jsonResponse({ choices: [{ message: { content: "x" } }], usage: {} });
    }),
  });
  assert.equal(seen.url, "https://gen.pollinations.ai/v1/chat/completions");
  assert.equal(seen.body.model, "openai/gpt-5.4-nano");
  assert.equal(seen.body.stream, false);
  assert.ok(seen.body.max_tokens >= 1000, "reasoning models need headroom above the old 400 cap");
  assert.ok(!JSON.stringify(seen.body).includes("http"), "no page URL may leak into the request");
});

test("a missing key is reported as AUTH_REQUIRED before any call", async () => {
  let called = false;
  const res = await handleStretchRequest(REQ, {
    token: null,
    fetchImpl: fakeFetch(async () => {
      called = true;
      return jsonResponse({});
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "AUTH_REQUIRED");
  assert.equal(called, false);
});

test("401 and 402 map to auth and balance errors", async () => {
  const r401 = await handleStretchRequest(REQ, {
    token: "sk_test",
    fetchImpl: fakeFetch(async () => jsonResponse({ error: "unauthorized" }, 401)),
  });
  assert.equal(r401.error.code, "AUTH_REJECTED");

  const r402 = await handleStretchRequest(REQ, {
    token: "sk_test",
    fetchImpl: fakeFetch(async () => jsonResponse({ error: "insufficient balance" }, 402)),
  });
  assert.equal(r402.error.code, "BALANCE_REQUIRED");
});

test("a network failure is reported as OFFLINE, not a crash", async () => {
  const res = await handleStretchRequest(REQ, {
    token: "sk_test",
    fetchImpl: fakeFetch(async () => {
      throw new TypeError("network down");
    }),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "OFFLINE");
});

test("malformed model output is rejected as BAD_OUTPUT", async () => {
  const res = await handleStretchRequest(REQ, {
    token: "sk_test",
    fetchImpl: fakeFetch(async () =>
      jsonResponse({ choices: [{ message: { content: "```md\nhello\n```" } }], usage: {} }),
    ),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "BAD_OUTPUT");
});

test("refreshPricing keeps only allowlisted tier models", async () => {
  const res = await refreshPricing({
    token: "sk_test",
    fetchImpl: fakeFetch(async () =>
      jsonResponse({
        data: [
          { id: "deepseek/deepseek-v4.1-flash", paid_only: false, pricing: { promptTextTokens: "0.00000015", completionTextTokens: "0.0000006" } },
          { id: "openai/gpt-5.4-nano", paid_only: true, pricing: { promptTextTokens: "0.1", completionTextTokens: "9" } },
          { id: "some/paid-model", paid_only: true, pricing: { promptTextTokens: "1", completionTextTokens: "9" } },
        ],
      }),
    ),
  });
  assert.equal(res.ok, true);
  assert.equal(res.pricing["openai/gpt-5.4-nano"].completionTextTokens, 0.0000009375, "paid-only price must not be adopted");
  assert.equal(res.pricing["deepseek/deepseek-v4.1-flash"].completionTextTokens, 0.0000006);
  assert.equal(res.pricing["some/paid-model"], undefined);
});

test("the device flow stores the key only after approval", async () => {
  const code = await handleDeviceCode({
    fetchImpl: fakeFetch(async () =>
      jsonResponse({ device_code: "dc", user_code: "ABCD-1234", verification_uri: "https://enter.pollinations.ai/device", expires_in: 1800, interval: 5 }),
    ),
  });
  assert.equal(code.ok, true);
  assert.equal(code.userCode, "ABCD-1234");

  const pending = await handleDeviceToken({
    fetchImpl: fakeFetch(async () => jsonResponse({ error: "authorization_pending" })),
  });
  assert.equal(pending.ok, false);
  assert.equal(pending.pending, true);

  const done = await handleDeviceToken({
    fetchImpl: fakeFetch(async () => jsonResponse({ access_token: "sk_user", token_type: "bearer" })),
  });
  assert.equal(done.ok, true);

  const status = await handleStatus();
  assert.equal(status.connected, true);
  assert.ok(status.typicalPollen > 0);
});

test("a rejected device flow is not treated as success", async () => {
  await handleDeviceCode({
    fetchImpl: fakeFetch(async () =>
      jsonResponse({ device_code: "dc2", user_code: "X", verification_uri: "https://x", expires_in: 1800, interval: 5 }),
    ),
  });
  const res = await handleDeviceToken({
    fetchImpl: fakeFetch(async () => jsonResponse({ error: "access_denied" })),
  });
  assert.equal(res.ok, false);
  assert.equal(res.error.code, "AUTH_REJECTED");
});
