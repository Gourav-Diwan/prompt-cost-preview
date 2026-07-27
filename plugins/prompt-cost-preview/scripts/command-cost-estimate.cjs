#!/usr/bin/env node
// UserPromptExpansion hook (declared in this plugin's plugin.json). Fires
// when the user invokes a slash command, BEFORE it expands into a prompt —
// the same before-it-runs cost gate prompt-cost-estimate.cjs applies to
// typed prompts, applied to slash commands instead.
//
// The payload this event sends carries only command_name/command_args/
// command_source/the raw typed text — NEVER the expanded instruction
// content that's actually about to run (confirmed empirically via a
// temporary debug hook; this event has no full I/O schema anywhere in the
// public hooks reference, unlike UserPromptSubmit). So this hook has to
// locate and read the command's own source file itself — see
// lib/resolve-command-content.cjs for the resolution strategy and its
// confidence levels per source. If it can't be found, this fails open
// silently (no estimate, no gate) rather than guess.
//
// decision:"block" support for THIS specific hook event is unconfirmed by
// any local documentation (only UserPromptSubmit's blocking behavior is
// confirmed via the hooks reference) — this was live-verified after
// building it, see the repo's implementation notes.
//
// This plugin's own commands (prompt-cost-preview:usage-estimate,
// prompt-cost-preview:retrain) are deliberately exempt — their own
// SKILL.md instructions are long enough to likely trip the threshold on
// every invocation, which would make using this plugin's own utilities
// annoying rather than useful (confirmed decision, not a default).
//
// Shares CLAUDE_CODE_PROMPT_COST_CONFIRM_THRESHOLD and the confirm-state
// file with prompt-cost-estimate.cjs (one dollar amount, one gate concept)
// rather than a second separate threshold.

const { resolveCommandContent } = require('./lib/resolve-command-content.cjs');
const { confirmGate } = require('./lib/confirm-gate.cjs');

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function fmtCost(n) {
  return '$' + n.toFixed(n < 0.01 ? 4 : 2);
}

function main(stdinText) {
  let payload;
  try {
    payload = JSON.parse(stdinText);
  } catch {
    process.stdout.write('{}');
    return;
  }

  const commandName = payload && payload.command_name;
  if (!commandName || typeof commandName !== 'string') { process.stdout.write('{}'); return; }

  // Self-gating exemption — this plugin's own commands never block on
  // their own instruction size.
  if (commandName.startsWith('prompt-cost-preview:')) { process.stdout.write('{}'); return; }

  const commandArgs = (payload && payload.command_args) || '';
  const cwd = (payload && payload.cwd) || process.cwd();
  const rawPrompt = (payload && payload.prompt) || `/${commandName}${commandArgs ? ' ' + commandArgs : ''}`;

  const content = resolveCommandContent({ command_name: commandName, cwd });
  if (!content) { process.stdout.write('{}'); return; }

  const text = (content + (commandArgs ? '\n' + commandArgs : '')).trim();
  if (!text) { process.stdout.write('{}'); return; }

  const g = require('./lib/load-globals.cjs')({ withWeights: true });
  const modelKey = process.env.CLAUDE_CODE_PLAN_ESTIMATE_MODEL || 'sonnet';
  const est = g.estimateTask(text, modelKey, { agentic: true });

  const MODEL_LABELS = { sonnet: 'Sonnet 5', opus: 'Opus 4.8', haiku: 'Haiku 4.5', fable: 'Fable 5' };
  const label = MODEL_LABELS[modelKey] || modelKey;
  const engineNote = est.engine === 'nn' ? '' : ' (heuristic fallback — no trained weights found)';
  const bucketLabel = (est.bucket && est.bucket.label) || est.bucket;
  const estimateLine =
    `Estimated cost for this command (${label}, agentic)${engineNote}: bucket ${bucketLabel} · ` +
    `~${fmtTokens(est.tokenLow)}–${fmtTokens(est.tokenHigh)} tokens, ${fmtCost(est.costLow)}–${fmtCost(est.costHigh)}.`;

  const threshold = parseFloat(process.env.CLAUDE_CODE_PROMPT_COST_CONFIRM_THRESHOLD || '0.50');
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;

  const result = confirmGate({
    textToHash: rawPrompt.trim(),
    estimateLine,
    costHigh: est.costHigh,
    threshold,
    dataDir,
    subjectLabel: 'command',
  });
  process.stdout.write(JSON.stringify(result));
}

let stdinText = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdinText += chunk; });
process.stdin.on('end', () => {
  try {
    main(stdinText);
  } catch {
    // Never let a broken estimate block command expansion.
    process.stdout.write('{}');
  }
});
