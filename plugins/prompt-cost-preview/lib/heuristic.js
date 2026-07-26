// AI Budget Tracker — cost-estimation heuristic.
// Vanilla globals (no modules), loaded via <script src="/heuristic.js"> before
// the React/Babel script in ai-budget-tracker.html. Swap this file for a
// trained classifier later (W3 roadmap) without touching the UI.

// ── Model + pricing table ────────────────────────────────────────────────────
// Prices are $ per MILLION tokens (input/output), verified against each
// provider's public docs as of 2026-07-09. THESE CHANGE OFTEN — if that date
// looks stale, re-verify before trusting a cost estimate.
// `provider` groups the model-selector UI; `other` is the free-text fallback
// ($0/$0, never suggested by routing).
const MODELS = {
  // Anthropic
  haiku:  { label: 'Claude Haiku 4.5',  provider: 'Anthropic', inPM: 1,  outPM: 5  },
  // ⚠️ Sonnet 5 pricing cliff: $2/$10 is an INTRODUCTORY rate through
  // 2026-08-31 — becomes $3/$15 after that date. Update this row then.
  sonnet: { label: 'Claude Sonnet 5',   provider: 'Anthropic', inPM: 2,  outPM: 10 },
  opus:   { label: 'Claude Opus 4.8',   provider: 'Anthropic', inPM: 5,  outPM: 25 },
  fable:  { label: 'Claude Fable 5',    provider: 'Anthropic', inPM: 10, outPM: 50 }, // Mythos-tier
  // OpenAI
  'gpt-mini': { label: 'GPT-5.4',     provider: 'OpenAI', inPM: 2.5, outPM: 15  },
  gpt:        { label: 'GPT-5.5',     provider: 'OpenAI', inPM: 5,   outPM: 30  },
  'gpt-pro':  { label: 'GPT-5.5 Pro', provider: 'OpenAI', inPM: 30,  outPM: 180 },
  // Google — gemini-pro rate is the ≤200K-context tier; doubles to $4/$18
  // above 200K context. Standard rate used as the default here.
  'gemini-lite':  { label: 'Gemini 3.1 Flash-Lite', provider: 'Google', inPM: 0.25, outPM: 1.5 },
  'gemini-flash': { label: 'Gemini 3.5 Flash',      provider: 'Google', inPM: 1.5,  outPM: 9   },
  'gemini-pro':   { label: 'Gemini 3.1 Pro',        provider: 'Google', inPM: 2,    outPM: 12  },
  // xAI
  'grok-fast': { label: 'Grok 4.1 Fast', provider: 'xAI', inPM: 0.2,  outPM: 0.5 },
  grok:        { label: 'Grok 4.3',      provider: 'xAI', inPM: 1.25, outPM: 2.5 },
  // Meta — Meta has no first-party API; these are DeepInfra's hosted rates
  // (cheapest host as of the verification date). Actual cost varies by host
  // (Groq / Together / Fireworks differ, sometimes 3-4x).
  'llama-8b':       { label: 'Llama 3.1 8B',     provider: 'Meta', inPM: 0.05, outPM: 0.08 },
  'llama-scout':    { label: 'Llama 4 Scout',    provider: 'Meta', inPM: 0.08, outPM: 0.3  },
  'llama-maverick': { label: 'Llama 4 Maverick', provider: 'Meta', inPM: 0.15, outPM: 0.6  },
  // Free-text fallback — no pricing, excluded from routing.
  other: { label: 'Other', provider: 'Other', inPM: 0, outPM: 0 },
};
// Cheapest-first (by blended 60/40 in/out cost) — the order suggestModel()
// walks. Cross-provider on purpose: the tool is an AI spend advisor, so the
// routing suggestion names the cheapest CAPABLE model anywhere in this list,
// not just the cheapest Anthropic one. `other` deliberately absent.
const MODEL_ORDER = [
  'llama-8b', 'llama-scout', 'grok-fast', 'llama-maverick', 'gemini-lite',
  'grok', 'haiku', 'gemini-flash', 'sonnet', 'gemini-pro', 'gpt-mini',
  'opus', 'gpt', 'fable', 'gpt-pro',
];

// ── Bucket scale — 8 tiers, XXS through 3XL ─────────────────────────────────
// XL is capped at 250 words (was uncapped) so XXL/3XL are reachable. Base
// in/out token splits keep the same ~60/40 shape the original 5 tiers used.
const BUCKETS = [
  { id: 'xxs', label: 'XXS', maxWords: 3,        inT: 90,     outT: 60,    desc: 'Micro — a couple of words' },
  { id: 'xs',  label: 'XS',  maxWords: 8,        inT: 300,    outT: 200,   desc: 'Tiny — one-liner or quick lookup' },
  { id: 's',   label: 'S',   maxWords: 20,       inT: 800,    outT: 600,   desc: 'Small — short write or simple question' },
  { id: 'm',   label: 'M',   maxWords: 50,       inT: 2500,   outT: 2000,  desc: 'Medium — a page of content or analysis' },
  { id: 'l',   label: 'L',   maxWords: 120,      inT: 7000,   outT: 5000,  desc: 'Large — deep research or long document' },
  { id: 'xl',  label: 'XL',  maxWords: 250,      inT: 18000,  outT: 12000, desc: 'Extra large — complex multi-step build' },
  { id: 'xxl', label: 'XXL', maxWords: 500,      inT: 45000,  outT: 30000, desc: 'Huge — multi-document, multi-part effort' },
  { id: '3xl', label: '3XL', maxWords: Infinity, inT: 108000, outT: 72000, desc: 'Massive — project-scale specification' },
];

const COMPLEXITY = ['build','create','design','architect','analyze','research','compare','generate','write','summarize','plan','review','implement','develop','debug','optimize','refactor','explain','convert'];
const HIGH_MODIFIERS = ['comprehensive','detailed','full','complete','enterprise','production','complex','advanced','multiple','entire','all','thorough','in-depth'];
const VOLUME_SIGNALS = [
  'step by step', 'full report', 'complete guide', 'entire',
  'all of', 'every', 'detailed breakdown', 'comprehensive list',
  'all files', 'whole codebase', 'end to end', 'from scratch',
  'complete implementation', 'full analysis', 'all the'
];

// Bucket-only advice that's true regardless of which model is selected.
// Deliberately does NOT include a "try a cheaper model" message for any
// bucket — suggestModel()'s routing suggestion in the UI already covers
// that, is more precise (knows taskType, names the actual model), and
// correctly disappears once the suggested model is selected; a second,
// bucket-only "could Haiku handle this?" message here would just keep
// showing after the user already took that advice.
const CHEAPER_SUGGESTION = {
  '3xl': 'This is a 3XL task — project-scale. Break it into phases and estimate each separately; a single estimate at this size is close to meaningless.',
  xxl: 'This is an XXL task — consider splitting it into a few large tasks to keep estimates (and spend) controllable.',
  xl: 'This is an XL task — consider breaking it into smaller steps to control spend.',
  l: null, m: null, s: null, xs: null, xxs: null,
};

// Task type keyword lists + multipliers applied to a bucket's base token estimate.
const TASK_TYPE_ORDER = ['email', 'code', 'research', 'creative'];
const TASK_TYPES = {
  email:    { keywords: ['email', 'reply to', 'respond to', 'follow up', 'draft a message', 'draft a note'], inMult: 0.8, outMult: 0.6 },
  code:     { keywords: ['code', 'function', 'bug', 'refactor', 'script', 'api', 'debug', 'implement', 'unit test', 'class ', 'component', 'endpoint'], inMult: 1.1, outMult: 1.6 },
  research: { keywords: ['research', 'analyze', 'investigate', 'compare', 'summarize', 'report on', 'study', 'review the', 'literature'], inMult: 1.6, outMult: 1.2 },
  creative: { keywords: ['story', 'poem', 'blog post', 'creative', 'brainstorm', 'marketing copy', 'tagline', 'name ideas', 'social post'], inMult: 0.9, outMult: 1.4 },
};

// Capability map: which models can handle a bucket index (0=xxs..7=3xl) +
// task type. Ceilings are judgment calls per model tier (small/fast models
// top out at S; mid tiers at L/XL; flagships reach XXL/3XL) — documented in
// CLAUDE.md's model table. suggestModel() walks MODEL_ORDER cheapest-first
// against this, so a low ceiling just means "never suggested for big tasks",
// not "can't be selected manually".
const ALL_TYPES = ['email', 'code', 'research', 'creative', 'other'];
const MODEL_CAPABILITY = {
  'llama-8b':       { maxBucketIdx: 1, types: ['email', 'other'] },
  'llama-scout':    { maxBucketIdx: 3, types: ['email', 'creative', 'other'] },
  'grok-fast':      { maxBucketIdx: 2, types: ['email', 'creative', 'other'] },
  'llama-maverick': { maxBucketIdx: 4, types: ALL_TYPES },
  'gemini-lite':    { maxBucketIdx: 2, types: ['email', 'creative', 'other'] },
  grok:             { maxBucketIdx: 5, types: ALL_TYPES },
  haiku:            { maxBucketIdx: 2, types: ['email', 'creative', 'other'] },
  'gemini-flash':   { maxBucketIdx: 4, types: ALL_TYPES },
  sonnet:           { maxBucketIdx: 5, types: ALL_TYPES },
  'gemini-pro':     { maxBucketIdx: 6, types: ALL_TYPES },
  'gpt-mini':       { maxBucketIdx: 4, types: ALL_TYPES },
  opus:             { maxBucketIdx: 6, types: ALL_TYPES },
  gpt:              { maxBucketIdx: 6, types: ALL_TYPES },
  fable:            { maxBucketIdx: 7, types: ALL_TYPES },
  'gpt-pro':        { maxBucketIdx: 7, types: ALL_TYPES },
};

function detectTaskType(text) {
  const lower = text.toLowerCase();
  for (const type of TASK_TYPE_ORDER) {
    if (TASK_TYPES[type].keywords.some(k => lower.includes(k))) return type;
  }
  return 'other';
}

// Returns { bucket, taskType, confidence, complexityHit, modifierHit, volumeHit,
// tokenLow, tokenHigh, costLow, costHigh }. Three independent bump signals —
// complexity keywords, high modifiers, volume/output-size phrases — each move
// the bucket up by 1, capped at +2 total. Confidence drops as more signals
// stack (each one compounds uncertainty), which widens the token/cost range.
// modelKey defaults to 'sonnet' but callers should pass the actually-selected
// model so costLow/costHigh reflect real pricing.
function bucketTask(text, modelKey = 'sonnet') {
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean).length;

  const complexityHit = COMPLEXITY.some(w => lower.includes(w));
  const modifierHit = HIGH_MODIFIERS.some(w => lower.includes(w));
  const volumeHit = VOLUME_SIGNALS.some(w => lower.includes(w));
  const bump = Math.min([complexityHit, modifierHit, volumeHit].filter(Boolean).length, 2);

  let idx = BUCKETS.findIndex(b => words <= b.maxWords);
  if (idx === -1) idx = BUCKETS.length - 1;
  idx = Math.min(idx + bump, BUCKETS.length - 1);
  const bucket = BUCKETS[idx];

  const taskType = detectTaskType(text);
  const typeDef = TASK_TYPES[taskType] || { inMult: 1, outMult: 1 };
  const midInT = bucket.inT * typeDef.inMult;
  const midOutT = bucket.outT * typeDef.outMult;
  const midTotal = midInT + midOutT;
  const outShare = midTotal > 0 ? midOutT / midTotal : 0.5;

  const confidence = bump === 0 ? 'high' : bump === 1 ? 'medium' : 'low';
  const spread = confidence === 'high' ? 0.2 : confidence === 'medium' ? 0.4 : 0.7;

  const tokenLow = Math.round(midTotal * (1 - spread));
  const tokenHigh = Math.round(midTotal * (1 + spread));
  const costRange = calcCostRange({ low: tokenLow, high: tokenHigh, outShare }, modelKey);

  return {
    bucket,
    taskType,
    confidence,
    complexityHit,
    modifierHit,
    volumeHit,
    tokenLow,
    tokenHigh,
    costLow: costRange.low.total,
    costHigh: costRange.high.total,
  };
}

function calcCost(tokens, modelKey) {
  const m = MODELS[modelKey];
  const inC = (tokens.inT / 1e6) * m.inPM;
  const outC = (tokens.outT / 1e6) * m.outPM;
  return { inC, outC, total: inC + outC };
}

// Cost range from a bucketTask() estimate's low/high token totals, split
// in/out using its outShare.
function calcCostRange(estimate, modelKey) {
  const split = total => {
    const outT = Math.round(total * estimate.outShare);
    return { inT: total - outT, outT };
  };
  return {
    low: calcCost(split(estimate.low), modelKey),
    high: calcCost(split(estimate.high), modelKey),
  };
}

// Cheapest model (in MODEL_ORDER, cross-provider) capable of the given
// bucket + task type. Falls back to fable (highest ceiling, cheaper than
// gpt-pro) if nothing matches — shouldn't happen since fable covers 3xl/all.
function suggestModel(bucket, taskType) {
  const idx = BUCKETS.findIndex(b => b.id === bucket.id);
  const type = TASK_TYPES[taskType] ? taskType : 'other';
  for (const key of MODEL_ORDER) {
    const cap = MODEL_CAPABILITY[key];
    if (idx <= cap.maxBucketIdx && cap.types.includes(type)) return key;
  }
  return 'fable';
}
