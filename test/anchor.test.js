import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";
import { cacheKey, hashString, newAnchorId } from "../lib/anchor.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");

/** Pull the inlined hashString/cacheKey out of content.js and run them. */
function loadInlined() {
  const src = fs.readFileSync(path.join(root, "content.js"), "utf-8");
  const start = src.indexOf("function hashString(");
  const end = src.indexOf("function newAnchorId(");
  const block = src.slice(start, end);
  const ctx = { module: { exports: {} } };
  vm.createContext(ctx);
  vm.runInContext(`${block}\nthis.__hashString = hashString; this.__cacheKey = cacheKey;`, ctx);
  return { hashString: ctx.__hashString, cacheKey: ctx.__cacheKey };
}

test("the inlined copy in content.js computes exactly the same keys as lib/anchor.js", () => {
  const inlined = loadInlined();
  const samples = [
    { selection: "photosynthesis", before: "Plants use ", after: " to produce sugars." },
    { text: "Carthage", before: "", after: " was founded by Phoenician settlers." },
    { selection: "a b c", before: "x", after: "y" },
    { selection: "", before: "", after: "" },
    { selection: "  padded  ", before: "  b ", after: " a  " },
  ];
  for (const s of samples) {
    assert.equal(
      inlined.cacheKey(s),
      cacheKey(s),
      `keys differ for ${JSON.stringify(s)}`,
    );
  }
});

test("the cache key contains the selected text, not only the context", () => {
  const a = cacheKey({ selection: "photosynthesis", before: "Plants use ", after: " to produce sugars." });
  const b = cacheKey({ selection: "respiration", before: "Plants use ", after: " to produce sugars." });
  assert.notEqual(a, b, "two different selections in the same paragraph must not share a key");
});

test("two different paragraphs with the same context are still distinct", () => {
  const a = cacheKey({ selection: "Carthage", before: "was founded by ", after: " in the eighth century." });
  const b = cacheKey({ selection: "Carthage", before: "was destroyed by ", after: " in the third century." });
  assert.notEqual(a, b);
});

test("the inlined hash is the same FNV-1a", () => {
  const inlined = loadInlined();
  for (const s of ["", "a", "photosynthesis", "한글 테스트", "😀"]) {
    assert.equal(inlined.hashString(s), hashString(s));
  }
});

test("anchor ids are unique", () => {
  const ids = new Set();
  for (let i = 0; i < 500; i++) ids.add(newAnchorId());
  assert.equal(ids.size, 500);
  assert.match([...ids][0], /^a[0-9a-z]+$/);
});
