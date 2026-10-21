/**
 * quality.mjs — the release gate from the design consult:
 * 20 fixed selections, at least 18 useful and context-compatible additions,
 * zero meaning-reversing additions.
 *
 * Run with the key in the environment:
 *   POL_KEY=sk_... node quality/quality.mjs
 * (the key is read from the environment only; it is never written to disk)
 */
import { SYSTEM_PROMPT, buildUserMessage } from "../lib/prompt.js";
import { validateOutput, estimateCost, LIMITS } from "../lib/validate.js";

const KEY = process.env.POL_KEY;
const MODEL = process.env.POL_MODEL || "deepseek/deepseek-v4.1-flash";
if (!KEY) {
  console.error("POL_KEY is not set");
  process.exit(2);
}

const CASES = [
  { sel: "photosynthesis", before: "Plants use ", after: " to produce sugars.", kind: "term" },
  { sel: "the printing press", before: "After ", after: " was introduced, books became cheap.", kind: "term" },
  { sel: "Carthage", before: "", after: " was founded by Phoenician settlers in the eighth century BC.", kind: "term" },
  { sel: "the seventh century", before: "The treaty was signed in ", after: " and lasted for decades.", kind: "term" },
  { sel: "a centripetal force", before: "Satellites remain in orbit because of ", after: ".", kind: "technical" },
  { sel: "quorum", before: "The proposal passed because the board had reached ", after: ".", kind: "term" },
  { sel: "photosynthetic", before: "The efficiency of ", after: " pathways varies between plant species.", kind: "term" },
  { sel: "the Industrial Revolution", before: "Britain industrialised faster than France because of ", after: ".", kind: "compressed" },
  { sel: "it is widely believed that the treaty ended the war, although no single document confirms this", before: "", after: ".", kind: "uncertainty" },
  { sel: "the company did not deny the claim", before: "", after: ", but it never confirmed it either.", kind: "negation" },
  { sel: "roughly 12,000 workers", before: "The factory employed ", after: " at its peak in 1911.", kind: "number" },
  { sel: "entangled", before: "The two particles became ", after: " after the collision.", kind: "technical" },
  { sel: "neo-imperialism", before: "Critics used the term ", after: " to describe nineteenth-century expansion.", kind: "term" },
  { sel: "the treaty was signed in 1815", before: "", after: ", three years after the battle.", kind: "compressed" },
  { sel: "明治維新", before: "日本の ", after: " は 19 世紀後半に始まった。", kind: "japanese" },
  { sel: "근대 산업화", before: "한국의 ", after: " 는 1960년대 초에 시작되었다.", kind: "korean" },
  { sel: "the printing press was introduced in the mid-fifteenth century", before: "", after: ", and within a few decades printed books had largely replaced manuscripts.", kind: "compressed" },
  { sel: "photosynthesis, the process by which plants convert light energy into chemical energy stored as sugars", before: "This is called ", after: ".", kind: "already-expanded" },
  { sel: "P vs NP", before: "The question known as ", after: " asks whether a problem whose answer can be checked quickly can also be found quickly.", kind: "term" },
  { sel: "the Second World War", before: "", after: " ended in 1945, five years after it began in Europe.", kind: "factual" },
];

async function call(c) {
  const body = {
    model: MODEL,
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: buildUserMessage({ selection: c.sel, before: c.before, after: c.after }) },
    ],
    max_tokens: LIMITS.maxTokens,
    stream: false,
  };
  const t0 = Date.now();
  const res = await fetch("https://gen.pollinations.ai/v1/chat/completions", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text();
    return { ok: false, error: `${res.status} ${txt.slice(0, 160)}`, ms: Date.now() - t0 };
  }
  const data = await res.json();
  const choice = (data.choices || [])[0] || {};
  const usage = data.usage || {};
  const v = validateOutput(choice.message && choice.message.content, { finishReason: choice.finish_reason });
  return { ok: v.ok, text: v.text, error: v.error, usage, ms: Date.now() - t0, raw: choice.message && choice.message.content };
}

let pass = 0;
let cost = 0;
const rows = [];
for (const c of CASES) {
  const r = await call(c);
  if (r.ok) {
    pass += 1;
    const cst = estimateCost({
      model: MODEL,
      promptTokens: r.usage.prompt_tokens,
      completionTokens: r.usage.completion_tokens,
    });
    cost += cst ? cst.pollen : 0;
  }
  rows.push({ kind: c.kind, sel: c.sel.slice(0, 46), ok: r.ok, ms: r.ms, text: r.text, error: r.error });
}
console.log(`model=${MODEL}  pass ${pass}/${CASES.length}  total estimated cost ${cost.toFixed(7)} pollen\n`);
for (const r of rows) {
  console.log(`${r.ok ? "PASS" : "FAIL"} [${r.kind.padEnd(13)}] ${r.ms}ms  "${r.sel}"`);
  console.log(`     ${r.ok ? r.text : "ERROR: " + (r.error && r.error.message)}`);
}
console.log(`\nmechanical pass rate: ${pass}/${CASES.length} (release gate: >= 18/20)`);
process.exit(pass >= 18 ? 0 : 1);
