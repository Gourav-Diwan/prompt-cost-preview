// In-browser port of scripts/train-token-model.cjs's core training math —
// the same tiny MLP (29 features -> 6 tanh -> 2 outputs), full-batch Adam,
// L2, best-val checkpointing, early stopping, residual sigma, and
// session-sum calibration. Featurization comes from the already-loaded
// lib/token-model-core.js globals (featurizeTask/bucketTask), so
// training-time and inference-time features cannot drift — the exact
// property the Node trainer gets via vm/load-globals.
//
// Deliberately NOT ported: CSV parsing, MODEL_RATES/costToTokens (no
// manual-CSV branch here), the external-transcript branch, the eval-report
// writer, all fs I/O, and CLI flags — hyperparameters are hardcoded to the
// swept defaults (hidden 6, LR 0.01, L2 0.05, 4000 epochs).
//
// Differences from the Node trainer's dataset blend: the extension has only
// (a) locally-mined Claude Code rows (weight 3, agentic:1, with real
// session ids for the session-position features) and (b) SEED_PROMPTS
// weak labels (weight 1, agentic:0) — see seed-prompts.js for why (b) is
// required, not optional.

var TRAIN_MIN_ROWS = 200; // raised from the Chrome extension's 20 to match this repo's 200-row NN-readiness bar
var TRAIN_WARN_ROWS = 30;  // below this, warn that the base model is likely still better

function trainerLogit(p) {
  var q = Math.max(0.02, Math.min(0.98, p));
  return Math.log(q / (1 - q));
}

function trainerMulberry32(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    var t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Mined rows (already globally timestamp-sorted by mergeMinedRows) ->
// training samples. Mirrors loadDataset()'s session branch: per-session
// turn counters and prior-token accumulation feed the two
// session-position features.
function buildSamples(rows) {
  var samples = [];
  var sessionPos = new Map();
  rows.forEach(function (r) {
    var task = String(r.task || '');
    var total = Number(r.total_tokens);
    if (!task || !(total > 0)) return;
    var pos = sessionPos.get(r.session) || { turns: 0, tokens: 0 };
    samples.push({
      x: featurizeTask(task, { agentic: 1, turnIndex: pos.turns, priorTokens: pos.tokens }),
      yTok: Math.log(total),
      yShare: trainerLogit(Number(r.out_share)),
      w: 3, shareW: 1, real: true, agentic: true, task: task, session: r.session,
    });
    sessionPos.set(r.session, { turns: pos.turns + 1, tokens: pos.tokens + total });
  });
  // Seed-prompt weak labels, distilled from the CURRENT heuristic.
  SEED_PROMPTS.forEach(function (p) {
    var h = bucketTask(p);
    samples.push({
      x: featurizeTask(p, { agentic: 0 }),
      yTok: Math.log((h.tokenLow + h.tokenHigh) / 2),
      yShare: trainerLogit(0.4),
      w: 1, shareW: 0.1, real: false, agentic: false, task: p,
    });
  });
  return samples;
}

// trainPersonalModel(rows, { onProgress }) -> Promise<{weights, stats}>
// onProgress({ epoch, epochs, valLoss }) fires every chunk. The epoch loop
// yields to the event loop every 100 epochs so the options page stays
// responsive (total runtime is a few seconds at a few hundred rows).
async function trainPersonalModel(rows, opts) {
  var onProgress = (opts && opts.onProgress) || function () {};
  var EPOCHS = 4000, H = 6, LR = 0.01, L2 = 0.05;

  var samples = buildSamples(rows);
  var nReal = samples.filter(function (s) { return s.real; }).length;
  if (nReal < TRAIN_MIN_ROWS) {
    throw new Error('Only ' + nReal + ' mined rows — need at least ' + TRAIN_MIN_ROWS + '. Mine more sessions first.');
  }
  var D = samples[0].x.length;

  // normalize
  var mean = new Array(D).fill(0), std = new Array(D).fill(0);
  samples.forEach(function (s) { s.x.forEach(function (v, i) { mean[i] += v / samples.length; }); });
  samples.forEach(function (s) { s.x.forEach(function (v, i) { std[i] += Math.pow(v - mean[i], 2) / samples.length; }); });
  for (var i = 0; i < D; i++) std[i] = Math.sqrt(std[i]) || 1;
  samples.forEach(function (s) { s.xn = s.x.map(function (v, i) { return (v - mean[i]) / std[i]; }); });

  // split 80/20, seeded
  var rand = trainerMulberry32(42);
  var idx = samples.map(function (_, i) { return i; }).sort(function () { return rand() - 0.5; });
  var nVal = Math.max(4, Math.floor(samples.length * 0.2));
  var val = idx.slice(0, nVal).map(function (i) { return samples[i]; });
  var train = idx.slice(nVal).map(function (i) { return samples[i]; });

  // params
  var init = function (r, c) {
    return Array.from({ length: r }, function () {
      return Array.from({ length: c }, function () { return (rand() * 2 - 1) * Math.sqrt(1 / r); });
    });
  };
  var W1 = init(D, H), b1 = new Array(H).fill(0);
  var W2 = init(H, 2), b2 = new Array(2).fill(0);

  var forward = function (xn) {
    var h = b1.map(function (b, j) {
      var z = b;
      for (var i = 0; i < D; i++) z += xn[i] * W1[i][j];
      return Math.tanh(z);
    });
    var o = b2.map(function (b, k) {
      var z = b;
      for (var j = 0; j < H; j++) z += h[j] * W2[j][k];
      return z;
    });
    return { h: h, o: o };
  };
  var lossOf = function (set) {
    var l = 0, wSum = 0;
    set.forEach(function (s) {
      var o = forward(s.xn).o;
      l += s.w * (Math.pow(o[0] - s.yTok, 2) + 0.3 * s.shareW * Math.pow(o[1] - s.yShare, 2));
      wSum += s.w;
    });
    return l / wSum;
  };

  // Adam state
  var zero = function (a) { return a.map(function (r) { return Array.isArray(r) ? r.map(function () { return 0; }) : 0; }); };
  var mW1 = zero(W1), vW1 = zero(W1), mW2 = zero(W2), vW2 = zero(W2);
  var mb1 = b1.slice().fill(0), vb1 = b1.slice().fill(0), mb2 = b2.slice().fill(0), vb2 = b2.slice().fill(0);
  var B1 = 0.9, B2 = 0.999, EPS = 1e-8;

  var best = { loss: Infinity, snap: null, epoch: 0 };
  var stopped = false;

  for (var chunkStart = 1; chunkStart <= EPOCHS && !stopped; chunkStart += 100) {
    var chunkEnd = Math.min(chunkStart + 99, EPOCHS);
    for (var ep = chunkStart; ep <= chunkEnd; ep++) {
      // full-batch gradients
      var gW1 = zero(W1), gW2 = zero(W2), gb1 = b1.slice().fill(0), gb2 = b2.slice().fill(0);
      var wSum = train.reduce(function (s, t) { return s + t.w; }, 0);
      for (var si = 0; si < train.length; si++) {
        var s = train[si];
        var fw = forward(s.xn);
        var h = fw.h, o = fw.o;
        var dO = [
          (2 * s.w * (o[0] - s.yTok)) / wSum,
          (2 * 0.3 * s.w * s.shareW * (o[1] - s.yShare)) / wSum,
        ];
        for (var j = 0; j < H; j++) {
          for (var k = 0; k < 2; k++) gW2[j][k] += h[j] * dO[k];
        }
        for (var k2 = 0; k2 < 2; k2++) gb2[k2] += dO[k2];
        for (var j2 = 0; j2 < H; j2++) {
          var dh = 0;
          for (var k3 = 0; k3 < 2; k3++) dh += dO[k3] * W2[j2][k3];
          var dz = dh * (1 - h[j2] * h[j2]);
          for (var i2 = 0; i2 < D; i2++) gW1[i2][j2] += s.xn[i2] * dz;
          gb1[j2] += dz;
        }
      }
      var adam = function (p, gp, m, v, l2, epNow) {
        for (var pi = 0; pi < p.length; pi++) {
          var grad = gp[pi] + l2 * p[pi];
          m[pi] = B1 * m[pi] + (1 - B1) * grad;
          v[pi] = B2 * v[pi] + (1 - B2) * grad * grad;
          p[pi] -= (LR * (m[pi] / (1 - Math.pow(B1, epNow)))) / (Math.sqrt(v[pi] / (1 - Math.pow(B2, epNow))) + EPS);
        }
      };
      for (var wi = 0; wi < D; wi++) adam(W1[wi], gW1[wi], mW1[wi], vW1[wi], L2, ep);
      for (var wj = 0; wj < H; wj++) adam(W2[wj], gW2[wj], mW2[wj], vW2[wj], L2, ep);
      adam(b1, gb1, mb1, vb1, 0, ep);
      adam(b2, gb2, mb2, vb2, 0, ep);

      if (ep % 25 === 0 || ep === 1) {
        var vl = lossOf(val);
        if (vl < best.loss) {
          best = { loss: vl, epoch: ep, snap: JSON.parse(JSON.stringify({ W1: W1, b1: b1, W2: W2, b2: b2 })) };
        } else if (ep - best.epoch > 600) { stopped = true; break; } // early stop
      }
    }
    onProgress({ epoch: Math.min(chunkEnd, EPOCHS), epochs: EPOCHS, valLoss: best.loss });
    await new Promise(function (r) { setTimeout(r, 0); }); // keep the page responsive
  }
  W1 = best.snap.W1; b1 = best.snap.b1; W2 = best.snap.W2; b2 = best.snap.b2;

  // residual sigma — same eval-set choice + inflate rule as the Node trainer
  var realRows = samples.filter(function (s) { return s.real; });
  var valReal = val.filter(function (s) { return s.real; });
  var evalSet = valReal.length >= 8 ? valReal : realRows;
  var inflate = evalSet === realRows ? 1.2 : 1;
  var residuals = evalSet.map(function (s) { return forward(s.xn).o[0] - s.yTok; });
  var sigma = Math.sqrt(residuals.reduce(function (a, r) { return a + r * r; }, 0) / residuals.length) * inflate;

  // base-vs-personal comparison on the real rows (median abs log error as ×-factor)
  var medAbs = function (arr) {
    var a = arr.map(Math.abs).sort(function (x, y) { return x - y; });
    return a[Math.floor(a.length / 2)];
  };
  var personalErr = realRows.map(function (s) { return forward(s.xn).o[0] - s.yTok; });
  var baseErr = realRows.map(function (s) {
    return runTokenModel(s.x, BASE_WEIGHTS_SNAPSHOT)[0] - s.yTok;
  });
  var heurErr = realRows.map(function (s) {
    var h = bucketTask(s.task);
    return Math.log((h.tokenLow + h.tokenHigh) / 2) - s.yTok;
  });

  // session-sum calibration — geo-mean over sessions with >=3 turns,
  // mirroring nnEstimateTask's clamp on each midpoint
  var bySession = new Map();
  samples.forEach(function (s) {
    if (!s.session) return;
    var agg = bySession.get(s.session) || { act: 0, est: 0, n: 0 };
    agg.est += Math.min(Math.max(Math.exp(forward(s.xn).o[0]), 100), 6e6);
    agg.act += Math.exp(s.yTok);
    agg.n++;
    bySession.set(s.session, agg);
  });
  var sessionRatios = Array.from(bySession.values())
    .filter(function (a) { return a.n >= 3; })
    .map(function (a) { return a.act / a.est; });
  var sessionSumCal = sessionRatios.length >= 3
    ? Number(Math.exp(sessionRatios.reduce(function (a, r) { return a + Math.log(r); }, 0) / sessionRatios.length).toFixed(4))
    : 1;

  var weights = {
    version: 1,
    norm: { mean: mean, std: std },
    layers: [{ w: W1, b: b1 }, { w: W2, b: b2 }],
    residualSigma: Number(sigma.toFixed(4)),
    sessionSumCalibration: sessionSumCal,
    meta: {
      trainedAt: new Date().toISOString(),
      rows: samples.length,
      realRows: nReal,
      features: D,
      hidden: H,
      valLoss: Number(best.loss.toFixed(4)),
      source: 'personal',
    },
  };

  var toX = function (e) { return Number(Math.exp(medAbs(e)).toFixed(2)); };
  return {
    weights: weights,
    stats: {
      rows: samples.length,
      realRows: nReal,
      valLoss: Number(best.loss.toFixed(4)),
      bestEpoch: best.epoch,
      residualSigma: Number(sigma.toFixed(3)),
      sessionSumCalibration: sessionSumCal,
      sessionCount: sessionRatios.length,
      personalMedianX: toX(personalErr),
      baseMedianX: toX(baseErr),
      heuristicMedianX: toX(heurErr),
    },
  };
}
