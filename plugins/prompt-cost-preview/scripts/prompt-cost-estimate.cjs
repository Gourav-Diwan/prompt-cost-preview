#!/usr/bin/env node
// UserPromptSubmit hook (declared in this plugin's plugin.json — see the
// "hooks" field). Fires every time the user submits a regular prompt,
// before Claude processes it — the "feedback about the estimated cost of
// the prompt in agent mode" the plugin promises, for ordinary turns (the
// ExitPlanMode hook, plan-cost-estimate.cjs, covers Plan Mode's plans).
//
// Below CLAUDE_CODE_PROMPT_COST_CONFIRM_THRESHOLD (default $0.50, compared
// against costHigh): informational only — emits a systemMessage, never
// touches decision/reason. Above it: this hook DOES block — confirmed via
// the hooks reference that UserPromptSubmit has no pause-and-wait-for-input
// option (that only exists for PreToolUse's permissionDecision:"ask"), so
// "ask before an expensive prompt runs" is only achievable here as
// block-with-reason + a resend-to-confirm loop, not a true pause. Blocking
// erases the prompt, so the gate is deliberately narrow (a $ threshold, not
// e.g. bucket-based — testing showed agentic-mode buckets skew high across
// nearly every prompt, per this repo's own ~100x agentic-vs-chat scaling)
// and confirmation is tracked in ${CLAUDE_PLUGIN_DATA}/
// pending-cost-confirmations.json so resending the IDENTICAL prompt text
// within 5 minutes passes it through instead of blocking again. Without
// CLAUDE_PLUGIN_DATA (no persistent place to record the confirmation) this
// falls back to the original informational-only behavior — never block
// without a way to unblock. This project's established "inform, never
// hard-block by default" precedent (the Cursor extension's
// beforeSubmitPrompt gate, extension-cursor/cursor-hooks/
// before-submit-prompt.cjs) still holds for everything under threshold.
//
// The hash/threshold/state-file/block-or-confirm logic itself now lives in
// lib/confirm-gate.cjs, shared with command-cost-estimate.cjs
// (UserPromptExpansion, gates slash commands the same way) — not
// duplicated here.
//
// Deliberately fails silently (prints nothing / an empty object) on any
// error — a broken estimate must never block normal prompt submission.
//
// stdin payload's exact field carrying the prompt text ("prompt") was
// confirmed via the Claude Code hooks reference before writing this parser
// — not guessed.
//
// REAL BUG FOUND AND FIXED (live, in a `claude-desktop` session): Claude
// Code delivers system-generated events — a background-agent completion
// notification wrapped in `<task-notification>...</task-notification>`,
// chief among them — through `UserPromptSubmit` exactly like a real typed
// prompt, with no field distinguishing the two. Without a filter, this
// hook gated a huge dumped agent-result as if the user had typed it,
// blocking a turn the user never initiated and had no way to "resend"
// (they never typed it in the first place). SYNTHETIC_PREFIXES below is
// the same class of check `scripts/mine-session-data.cjs` already applies
// when mining transcripts — hand-synced here, not shared, matching this
// plugin's established per-script small-helper convention. Update all
// copies together if a new synthetic marker turns up (this exact gap —
// `<task-notification>` being new and present in NONE of the existing
// copies — is how this bug happened in the first place).

const SYNTHETIC_PREFIXES = [
  '<ide_opened_file>', '<ide_selection>', '<command-name>', '<command-message>',
  '<local-command-stdout', '<system-reminder>', '<task-notes>', '<task-notification>',
  'Caveat:', '[Request interrupted',
];
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/;

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

  const text = (payload && (payload.prompt || payload.user_prompt || '')).trim();
  if (!text) { process.stdout.write('{}'); return; }

  // Not something the user typed — a background-agent notification, an
  // IDE/system-injected block, or leaked ANSI-styled command output. Never
  // gate these: there's nothing for the user to knowingly "resend."
  if (SYNTHETIC_PREFIXES.some((p) => text.startsWith(p)) || ANSI_ESCAPE.test(text)) {
    process.stdout.write('{}');
    return;
  }

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
  const estimateLine =
    `Estimated cost for this prompt (${label}, agentic)${engineNote}: bucket ${bucketLabel} · ` +
    `~${fmtTokens(est.tokenLow)}–${fmtTokens(est.tokenHigh)} tokens, ${fmtCost(est.costLow)}–${fmtCost(est.costHigh)}.`;

  const threshold = parseFloat(process.env.CLAUDE_CODE_PROMPT_COST_CONFIRM_THRESHOLD || '0.50');
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;

  const result = confirmGate({
    textToHash: text,
    estimateLine,
    costHigh: est.costHigh,
    threshold,
    dataDir,
    subjectLabel: 'prompt',
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
    // Never let a broken estimate block prompt submission.
    process.stdout.write('{}');
  }
});
