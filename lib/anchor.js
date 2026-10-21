/**
 * lib/anchor.js — pure helpers shared by the extension.
 *
 * Two different identities, deliberately kept apart:
 *
 *  - `anchorId`  — the DOM identity of one inserted element. Unique per
 *    insertion, so two identical paragraphs never share tracking.
 *  - `cacheKey`  — the content identity of a stretch: the selected text plus
 *    the paragraph context around it. Stable, so shrinking and re-expanding
 *    the same phrase hits the cache instead of paying again.
 *
 * content.js cannot import modules (Chrome content scripts are classic
 * scripts), so it carries an inlined copy of `hashString` / `cacheKey`.
 * test/anchor.test.js evaluates that copy and compares its output with this
 * module, so the two cannot drift apart silently.
 */

/** FNV-1a, 32 bit. Small, fast, and stable across sessions. */
export function hashString(s) {
  let h = 0x811c9dc5;
  const str = String(s ?? "");
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** Separator that cannot appear in normal text, so fields cannot run together. */
const SEP = "\u0000";

/**
 * Stable key for one stretch: the selected text plus the paragraph context
 * around it. The **whole** context takes part (only the byte budget trims it),
 * and a hit is confirmed by comparing the stored fields, not the hash alone.
 * @param {{selection?: string, text?: string, before?: string, after?: string}} input
 */
export function cacheKey(input) {
  const i = input || {};
  const sel = String(i.selection ?? i.text ?? "").trim();
  const b = String(i.before ?? "").trim();
  const a = String(i.after ?? "").trim();
  return `k${hashString(sel + SEP + b + SEP + a)}`;
}

/** A fresh DOM identity for one inserted element. */
export function newAnchorId() {
  return `a${Date.now().toString(36)}${Math.random().toString(16).slice(2, 10)}`;
}
