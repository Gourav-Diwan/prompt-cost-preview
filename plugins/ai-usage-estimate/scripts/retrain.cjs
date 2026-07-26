#!/usr/bin/env node
// Mines ALL of this machine's own Claude Code sessions
// (~/.claude/projects/**/*.jsonl), trains a personalized copy of the
// bundled token-cost model on them, and writes the result to
// ${CLAUDE_PLUGIN_DATA}/personal-weights.json — a directory that persists
// across plugin updates. Every other script in this plugin
// (usage-estimate-session.cjs, plan-cost-estimate.cjs,
// prompt-cost-estimate.cjs) picks this up automatically the next time it
// runs, via lib/load-globals.cjs's personal-weights override — no
// restart or reinstall needed.
//
// The training math itself (trainPersonalModel, in lib/trainer.js) is a
// port of the Chrome extension's (extension/options/trainer.js) already-
// shipped, already-verified retrain core — not re-derived from the
// heavier Node train-token-model.cjs, which mixes in CSV blending, an
// eval-report writer, and CLI flags this plugin doesn't need.
//
// Usage: node retrain.cjs

const fs = require('fs');
const os = require('os');
const path = require('path');
const { mineFile } = require('./mine-session-data.cjs');
const loadGlobals = require('./lib/load-globals.cjs');

// Walks ~/.claude/projects/**/*.jsonl, skipping subagents/ dirs (sidechain
// usage already appears in the parent session file) — the same shape as
// mine-session-data.cjs's own inline main() walker, written fresh here
// since that walker isn't exported.
function findAllSessionFiles(projectsDir) {
  const files = [];
  (function walk(d) {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) {
        if (name === 'subagents') continue;
        walk(full);
      } else if (name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  })(projectsDir);
  return files;
}

function defaultSubagentBase() {
  if (typeof process.getuid !== 'function') return null;
  return `/tmp/claude-${process.getuid()}`;
}

// Turn -> training row, same formula mine-session-data.cjs's own main()
// uses to build its CSV rows: effective input (cache-weighted) + output.
function turnToRow(t, sessionId) {
  const effIn = Math.round(t.inputTokens + t.cacheCreate * 1.25 + t.cacheRead * 0.1);
  const total = effIn + t.outputTokens;
  return {
    task: t.text,
    total_tokens: total,
    out_share: total ? t.outputTokens / total : 0,
    session: sessionId,
  };
}

async function main() {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const files = findAllSessionFiles(projectsDir);
  if (!files.length) {
    console.log(`No Claude Code session transcripts found under ${projectsDir}.`);
    return;
  }

  const subagentBase = defaultSubagentBase();
  const rows = [];
  for (const f of files) {
    const sessionId = path.basename(f, '.jsonl');
    const { turns } = mineFile(f, subagentBase);
    for (const t of turns) rows.push(turnToRow(t, sessionId));
  }

  console.log(`Mined ${rows.length} prompt→usage rows from ${files.length} session file(s).`);

  const g = loadGlobals({ withWeights: true, withTrainer: true });

  let result;
  try {
    result = await g.trainPersonalModel(rows, {
      onProgress: (p) => {
        if (p.epoch === p.epochs || p.epoch % 500 === 0) {
          console.log(`  epoch ${p.epoch}/${p.epochs} — best val loss so far: ${p.valLoss.toFixed(4)}`);
        }
      },
    });
  } catch (err) {
    console.error(`Retrain failed: ${err.message}`);
    process.exitCode = 1;
    return;
  }

  const dataDir = process.env.CLAUDE_PLUGIN_DATA;
  if (!dataDir) {
    console.error('CLAUDE_PLUGIN_DATA is not set — cannot persist the personal model. Run this via the retrain skill, which sets it.');
    process.exitCode = 1;
    return;
  }
  fs.mkdirSync(dataDir, { recursive: true });
  const outPath = path.join(dataDir, 'personal-weights.json');
  fs.writeFileSync(outPath, JSON.stringify(result.weights));

  const s = result.stats;
  console.log(`\nWrote ${outPath}`);
  console.log(`Rows: ${s.rows} (${s.realRows} real, rest seed-prompt anchors) · sessions with ≥3 turns: ${s.sessionCount}`);
  console.log(`Validation loss: ${s.valLoss} (best epoch ${s.bestEpoch}) · residual σ: ${s.residualSigma} · session-sum calibration: ×${s.sessionSumCalibration}`);
  console.log(`Median error (×, closer to 1 is better) — personal: ×${s.personalMedianX}  base model: ×${s.baseMedianX}  heuristic fallback: ×${s.heuristicMedianX}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
