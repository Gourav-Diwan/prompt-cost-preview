#!/usr/bin/env node
// UserPromptSubmit hook (declared in this plugin's plugin.json — see the
// "hooks" field). Fires every time the user submits a regular prompt,
// before Claude processes it — the "feedback about the estimated cost of
// the prompt in agent mode" the plugin promises, for ordinary turns (the
// ExitPlanMode hook, plan-cost-estimate.cjs, covers Plan Mode's plans).
//
// Deliberately INFORMATIONAL ONLY — always emits a systemMessage, never
// `decision:"block"`/`continue:false`. Confirmed from the hooks reference:
// blocking a UserPromptSubmit hook "erases the prompt" entirely, so a false
// heuristic block would silently destroy the user's typed text. This
// matches this project's established precedent (the Cursor extension's
// beforeSubmitPrompt gate, extension-cursor/cursor-hooks/
// before-submit-prompt.cjs, is the same "inform, never hard-block by
// default" contract) — a future opt-in hard-block threshold is a possible
// follow-up, not built here.
//
// Deliberately fails silently (prints nothing / an empty object) on any
// error — a broken estimate must never block normal prompt submission.
//
// stdin payload's exact field carrying the prompt text ("prompt") was
// confirmed via the Claude Code hooks reference before writing this parser
// — not guessed.

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

  const text = (payload && (payload.prompt || payload.user_prompt || '')).trim();
  if (!text) { process.stdout.write('{}'); return; }

  // Skip trivially short prompts (e.g. "yes", "ok", "continue") — an
  // estimate on a 2-word confirmation is noise, not signal.
  if (text.split(/\s+/).length < 4) { process.stdout.write('{}'); return; }

  const g = require('./lib/load-globals.cjs')({ withWeights: true });
  const modelKey = process.env.CLAUDE_CODE_PLAN_ESTIMATE_MODEL || 'sonnet';
  const est = g.estimateTask(text, modelKey, { agentic: true });

  const MODEL_LABELS = { sonnet: 'Sonnet 5', opus: 'Opus 4.8', haiku: 'Haiku 4.5', fable: 'Fable 5' };
  const label = MODEL_LABELS[modelKey] || modelKey;
  const engineNote = est.engine === 'nn' ? '' : ' (heuristic fallback — no trained weights found)';
  const bucketLabel = (est.bucket && est.bucket.label) || est.bucket;
  const message =
    `📊 Estimated cost for this prompt (${label}, agentic)${engineNote}: bucket ${bucketLabel} · ` +
    `~${fmtTokens(est.tokenLow)}–${fmtTokens(est.tokenHigh)} tokens, ${fmtCost(est.costLow)}–${fmtCost(est.costHigh)}.`;

  process.stdout.write(JSON.stringify({ systemMessage: message }));
}

let stdinText = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => { stdinText += chunk; });
process.stdin.on('end', () => {
  try {
    main(stdinText);
  } catch {
    // Never let a broken estimate block prompt submission.
    process.stdout.write('{}');
  }
});
