import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cacheKey, hashString } from "../lib/anchor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

test("hashString is stable and differs for different input", () => {
  assert.equal(hashString("photosynthesis"), hashString("photosynthesis"));
  assert.notEqual(hashString("photosynthesis"), hashString("photosynthesin"));
  assert.match(hashString(""), /^[0-9a-z]+$/);
});

test("cacheKey is stable for the same selection and context", () => {
  const a = cacheKey({ selection: "photosynthesis", before: "Plants use ", after: " to produce sugars." });
  const b = cacheKey({ selection: "photosynthesis", before: "Plants use ", after: " to produce sugars." });
  assert.equal(a, b);
});

test("cacheKey changes when the selection or the context changes", () => {
  const base = { selection: "photosynthesis", before: "Plants use ", after: " to produce sugars." };
  assert.notEqual(cacheKey(base), cacheKey({ ...base, selection: "photosynthesis!" }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, before: "Animals use " }));
  assert.notEqual(cacheKey(base), cacheKey({ ...base, after: " in order to make sugars." }));
});

test("cacheKey ignores surrounding whitespace but not the words", () => {
  const a = cacheKey({ selection: " photosynthesis ", before: " Plants use ", after: " to produce sugars. " });
  const b = cacheKey({ selection: "photosynthesis", before: "Plants use", after: "to produce sugars." });
  assert.equal(a, b);
});

test("the inlined copy in content.js matches lib/anchor.js (no drift)", () => {
  const content = fs.readFileSync(path.join(root, "content.js"), "utf-8");
  const lib = fs.readFileSync(path.join(root, "lib", "anchor.js"), "utf-8");
  // same FNV-1a constants and same mixing order
  assert.ok(content.includes("0x811c9dc5"), "content.js must use the same FNV offset basis");
  assert.ok(content.includes("0x01000193"), "content.js must use the same FNV prime");
  assert.ok(lib.includes("0x811c9dc5"));
  assert.ok(lib.includes("0x01000193"));
  // same key shape
  assert.ok(/return `k\$\{hashString\(/.test(content), "content.js must build the same k-prefixed key");
  assert.ok(/return `k\$\{hashString\(/.test(lib), "lib/anchor.js must build the same k-prefixed key");
  // same trimming rules
  assert.ok(content.includes(".trim().slice(-200)") && content.includes(".trim().slice(0, 200)"));
  assert.ok(lib.includes(".trim().slice(-200)") && lib.includes(".trim().slice(0, 200)"));
});
