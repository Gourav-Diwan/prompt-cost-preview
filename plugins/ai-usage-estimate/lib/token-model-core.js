// AI Budget Tracker — neural token-estimate core (W6).
// Plain globals, same pattern as heuristic.js: loaded via
// <script src="/token-model-core.js"> AFTER heuristic.js (it reads
// COMPLEXITY / HIGH_MODIFIERS / VOLUME_SIGNALS / detectTaskType / BUCKETS /
// bucketTask / calcCostRange from that shared global scope) and BEFORE the
// text/babel UI script. Node scripts load it through
// scripts/lib/load-globals.cjs (vm) — do NOT add module.exports here.
//
// This file holds everything that must be identical at training time and at
// inference time: the featurizer and the MLP forward pass. The learned
// weights live in the generated token-model-weights.js (TOKEN_MODEL_WEIGHTS).
// If TOKEN_MODEL_WEIGHTS is absent, estimateTask() falls back to the W3
// heuristic — the page never breaks without a trained model.

const N_HASH_BUCKETS = 8;

// djb2 — stable, dependency-free string hash for the bag-of-words buckets.
function hashWord(w) {
  let h = 5381;
  for (let i = 0; i < w.length; i++) h = ((h << 5) + h + w.charCodeAt(i)) | 0;
  return Math.abs(h) % N_HASH_BUCKETS;
}

const FEATURE_NAMES = [
  'agentic',
  'logWords', 'logChars', 'avgWordLen', 'logLines',
  'complexityCount', 'modifierCount', 'volumeHit',
  'type_email', 'type_code', 'type_research', 'type_creative', 'type_other',
  'hasNumber', 'hasQuestion', 'hasCodeFence', 'hasUrl', 'hasFilePath',
  'imperativeStart',
  'logTurnIndex', 'logPriorTokens',
  ...Array.from({ length: N_HASH_BUCKETS }, (_, i) => 'bow_' + i),
];

// `agentic` is the single most important feature and it CANNOT be derived
// from the text: the same prompt costs ~100s of tokens as a one-shot chat
// message and ~100k+ as a Claude Code turn (tool calls, file reads, cache
// churn). The session data proved this — median agentic turn was ~370k
// effective tokens, ~12x the heuristic's XL ceiling. So execution mode is an
// explicit input (UI toggle), not a guess.
//
// `turnIndex`/`priorTokens` (session-position features, W7): the same short
// prompt costs very differently at turn 2 of a fresh session vs. turn 25 of
// a 20M-cache-read session — text features can't see that either, and the
// estimator was stuck at ~30% accuracy on deep cache-heavy sessions before
// these were added. turnIndex = 0-based position of this prompt in its
// session; priorTokens = sum of all previous turns' effective total tokens
// (effIn + out, the miner's total_tokens column). Both default to 0, which
// is exactly right for the browser UI's one-shot "what would this task
// cost?" estimates — that IS a start-of-session estimate.
function featurizeTask(text, opts = {}) {
  const lower = text.toLowerCase();
  const words = text.trim().split(/\s+/).filter(Boolean);
  const lines = text.split('\n').length;
  const taskType = detectTaskType(text);
  const typeOneHot = [...TASK_TYPE_ORDER, 'other'].map(t => (t === taskType ? 1 : 0));
  const complexityCount = COMPLEXITY.filter(w => lower.includes(w)).length;
  const modifierCount = HIGH_MODIFIERS.filter(w => lower.includes(w)).length;

  const bow = new Array(N_HASH_BUCKETS).fill(0);
  for (const w of words) {
    const clean = w.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (clean) bow[hashWord(clean)]++;
  }

  return [
    opts.agentic ? 1 : 0,
    Math.log(1 + words.length),
    Math.log(1 + text.length),
    words.length ? words.join('').length / words.length : 0,
    Math.log(lines),
    Math.min(complexityCount, 5),
    Math.min(modifierCount, 5),
    VOLUME_SIGNALS.some(s => lower.includes(s)) ? 1 : 0,
    ...typeOneHot,
    /\d/.test(text) ? 1 : 0,
    text.includes('?') ? 1 : 0,
    text.includes('```') ? 1 : 0,
    /https?:\/\//.test(lower) ? 1 : 0,
    /(^|\s)[\w.~-]*\/[\w./-]+/.test(text) ? 1 : 0,
    words.length && COMPLEXITY.includes(words[0].toLowerCase()) ? 1 : 0,
    Math.log(1 + (opts.turnIndex || 0)),
    Math.log(1 + (opts.priorTokens || 0)),
    ...bow.map(c => Math.log(1 + c)),
  ];
}

// Forward pass: z-score normalize, then dense layers with tanh on all but the
// last. W = { norm: { mean, std }, layers: [{ w: number[][], b: number[] }] }.
// Returns the raw output vector: [ logTokens, outShareLogit ].
function runTokenModel(features, W) {
  let a = features.map((v, i) => (v - W.norm.mean[i]) / (W.norm.std[i] || 1));
  W.layers.forEach((layer, li) => {
    const out = layer.b.map((b, j) => {
      let z = b;
      for (let i = 0; i < a.length; i++) z += a[i] * layer.w[i][j];
      return li < W.layers.length - 1 ? Math.tanh(z) : z;
    });
    a = out;
  });
  return a;
}

// Bucket whose base token total (inT+outT) is nearest to `tokens`, using
// geometric midpoints between adjacent buckets as the boundaries.
function bucketForTokens(tokens) {
  for (let i = 0; i < BUCKETS.length - 1; i++) {
    const a = BUCKETS[i].inT + BUCKETS[i].outT;
    const b = BUCKETS[i + 1].inT + BUCKETS[i + 1].outT;
    if (tokens <= Math.sqrt(a * b)) return BUCKETS[i];
  }
  return BUCKETS[BUCKETS.length - 1];
}

// Neural estimate in the same shape bucketTask() returns (plus engine/mid
// fields), so the UI can treat the two interchangeably. Returns null when no
// trained weights are loaded.
function nnEstimateTask(text, modelKey = 'sonnet', opts = {}) {
  if (typeof TOKEN_MODEL_WEIGHTS === 'undefined') return null;
  const W = TOKEN_MODEL_WEIGHTS;
  const [logTok, outShareLogit] = runTokenModel(featurizeTask(text, opts), W);
  // Clamp — tiny-data extrapolation guardrail: no real turn is under ~100
  // tokens or over a few million.
  const midTokens = Math.round(Math.min(Math.max(Math.exp(logTok), 100), 6e6));
  const outShare = 1 / (1 + Math.exp(-outShareLogit));
  // W.residualSigma is the validation-set std of log-space error — the
  // honest, data-driven ± band (heuristic confidence spreads are guesses).
  const s = W.residualSigma;
  const tokenLow = Math.round(midTokens * Math.exp(-s));
  const tokenHigh = Math.round(midTokens * Math.exp(s));
  const confidence = s <= 0.5 ? 'high' : s <= 0.95 ? 'medium' : 'low';
  const costRange = calcCostRange({ low: tokenLow, high: tokenHigh, outShare }, modelKey);
  const h = bucketTask(text, modelKey); // keyword badges + taskType still come from W3
  return {
    bucket: bucketForTokens(midTokens),
    taskType: h.taskType,
    confidence,
    complexityHit: h.complexityHit,
    modifierHit: h.modifierHit,
    volumeHit: h.volumeHit,
    tokenLow,
    tokenHigh,
    costLow: costRange.low.total,
    costHigh: costRange.high.total,
    engine: 'nn',
    midTokens,
    midInT: Math.round(midTokens * (1 - outShare)),
    midOutT: Math.round(midTokens * outShare),
    trainedOn: W.meta && W.meta.rows,
  };
}

// What the UI calls: neural when trained weights are present, W3 heuristic
// otherwise. Both return the bucketTask() shape; `engine` says which ran.
function estimateTask(text, modelKey = 'sonnet', opts = {}) {
  const nn = nnEstimateTask(text, modelKey, opts);
  if (nn) return nn;
  return { ...bucketTask(text, modelKey), engine: 'heuristic' };
}

// Session-SUM calibration factor (W7). The NN predicts each turn's MEDIAN
// tokens; summing medians of a right-skewed distribution systematically
// undershoots the sum of actuals (the few expensive turns dominate session
// cost). The trainer measures this on whole mined sessions and stores the
// geo-mean actual/predicted sum ratio in the weights; session aggregators
// (usage-estimate-session.cjs) multiply their per-turn midpoint costs by
// this. NOT applied to single-task estimates — the median is the right
// point estimate for "what will this one task cost?", and the UI's ±range
// already covers the spread. Exposed as a function (not a bare const read)
// because vm.runInContext only attaches function declarations to the
// context object — Node scripts can't see top-level consts (same gotcha as
// MODELS, see nnEstimateTask's comment).
function sessionSumCalibration() {
  return (typeof TOKEN_MODEL_WEIGHTS !== 'undefined' && TOKEN_MODEL_WEIGHTS.sessionSumCalibration) || 1;
}
