#!/usr/bin/env node
// PreToolUse hook, matcher "ExitPlanMode" (see .claude/settings.json).
//
// Fires right as Claude is about to present a finished plan for approval.
// Reads the most-recently-modified file in the Claude Code plans directory
// (ExitPlanMode itself carries no plan content — ExitPlanMode's own tool
// description says the plan is read from the file, not a parameter — so
// "most recently modified" is the same lookup convention
// usage-estimate-session.cjs already uses for finding the current session's
// transcript), feeds the plan's full text through this repo's own
// estimateTask() (agentic mode, since executing a plan is an agentic Claude
// Code session, not a one-shot chat), and surfaces the resulting token/cost
// range as a systemMessage — shown directly by the harness, independent of
// whether Claude's own response happens to mention it.
//
// This treats the whole plan's text as a single "prompt" fed to one agentic
// turn, the same mental model usage-estimate-session.cjs already uses per
// human turn — a reasonable proxy (the training data's real Claude Code
// turns already include everything that happened inside that turn, tool
// calls included), but it's a rough single-shot estimate: it does NOT model
// follow-up turns, back-and-forth revisions, or a plan that ends up
// executed very differently than written. Treat it as a ballpark, same ±
// spirit as every other estimate this project produces.
//
// Deliberately fails silently (prints nothing / an empty object) on any
// error — a broken estimate must never block Plan Mode from working.

const fs = require('fs');
const path = require('path');
const os = require('os');

function findLatestPlanFile() {
  const dir = process.env.CLAUDE_PLANS_DIR || path.join(os.homedir(), '.claude', 'plans');
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir)
    .filter((f) => f.endsWith('.md'))
    .map((f) => {
      const full = path.join(dir, f);
      return { full, mtime: fs.statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);
  return files.length ? files[0].full : null;
}

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function fmtCost(n) {
  return '$' + n.toFixed(n < 0.01 ? 4 : 2);
}

function main() {
  const planFile = findLatestPlanFile();
  if (!planFile) { process.stdout.write('{}'); return; }

  const text = fs.readFileSync(planFile, 'utf8').trim();
  if (!text) { process.stdout.write('{}'); return; }

  const g = require('./lib/load-globals.cjs')({ withWeights: true });
  const modelKey = process.env.CLAUDE_CODE_PLAN_ESTIMATE_MODEL || 'sonnet';
  const est = g.estimateTask(text, modelKey, { agentic: true });

  // MODELS is a top-level `const` inside heuristic.js — vm.runInContext only
  // attaches function declarations to the context object, not consts (same
  // gotcha token-model-core.js's own sessionSumCalibration() comment
  // flags), so g.MODELS isn't reachable here. A small local display-name
  // map avoids that entirely rather than adding another vm.runInContext call.
  const MODEL_LABELS = { sonnet: 'Sonnet 5', opus: 'Opus 4.8', haiku: 'Haiku 4.5', fable: 'Fable 5' };
  const label = MODEL_LABELS[modelKey] || modelKey;
  const engineNote = est.engine === 'nn' ? '' : ' (heuristic fallback — no trained weights found)';
  const message =
    `📊 Rough cost estimate to execute this plan (${label}, agentic)${engineNote}: ` +
    `~${fmtTokens(est.tokenLow)}–${fmtTokens(est.tokenHigh)} tokens, ` +
    `${fmtCost(est.costLow)}–${fmtCost(est.costHigh)}. ` +
    `Single-shot ballpark from the plan text — doesn't account for follow-up turns.`;

  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

try {
  main();
} catch (err) {
  // Never let a broken estimate block Plan Mode.
  process.stdout.write('{}');
}
