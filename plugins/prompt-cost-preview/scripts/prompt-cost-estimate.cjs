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
// Deliberately fails silently (prints nothing / an empty object) on any
// error — a broken estimate must never block normal prompt submission.
//
// stdin payload's exact field carrying the prompt text ("prompt") was
// confirmed via the Claude Code hooks reference before writing this parser
// — not guessed.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIRM_WINDOW_MS = 5 * 60 * 1000;

function fmtTokens(n) {
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(Math.round(n));
}

function fmtCost(n) {
  return '$' + n.toFixed(n < 0.01 ? 4 : 2);
}

// Reads/prunes/writes the pending-confirmation map. Never throws — a
// corrupt or unwritable state file must degrade to "no confirmations
// pending" (i.e. the next expensive prompt just re-blocks), never crash the
// hook or wedge prompt submission.
function loadPendingConfirmations(dataDir) {
  const file = path.join(dataDir, 'pending-cost-confirmations.json');
  let map = {};
  try {
    map = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    map = {};
  }
  const now = Date.now();
  for (const hash of Object.keys(map)) {
    if (typeof map[hash] !== 'number' || now - map[hash] > CONFIRM_WINDOW_MS) delete map[hash];
  }
  return { file, map };
}

function savePendingConfirmations(file, map) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(map));
  } catch {
    // Can't persist the confirmation — the resend will just block again
    // next time, which is the safe direction to fail in.
  }
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
  const estimateLine =
    `Estimated cost for this prompt (${label}, agentic)${engineNote}: bucket ${bucketLabel} · ` +
    `~${fmtTokens(est.tokenLow)}–${fmtTokens(est.tokenHigh)} tokens, ${fmtCost(est.costLow)}–${fmtCost(est.costHigh)}.`;

  const threshold = parseFloat(process.env.CLAUDE_CODE_PROMPT_COST_CONFIRM_THRESHOLD || '0.50');
  const dataDir = process.env.CLAUDE_PLUGIN_DATA;

  if (dataDir && Number.isFinite(threshold) && est.costHigh > threshold) {
    const hash = crypto.createHash('sha256').update(text).digest('hex');
    const { file, map } = loadPendingConfirmations(dataDir);

    if (map[hash]) {
      // A confirmed resend of the exact same prompt within the window —
      // single-use, so it can't be replayed again after this.
      delete map[hash];
      savePendingConfirmations(file, map);
      process.stdout.write(JSON.stringify({ systemMessage: `✅ Confirmed — proceeding. ${estimateLine}` }));
      return;
    }

    map[hash] = Date.now();
    savePendingConfirmations(file, map);
    process.stdout.write(JSON.stringify({
      decision: 'block',
      reason:
        `📊 ${estimateLine} This is above your $${threshold.toFixed(2)} confirm threshold. ` +
        `Resend this exact same prompt within 5 minutes to confirm and proceed.`,
    }));
    return;
  }

  process.stdout.write(JSON.stringify({ systemMessage: `📊 ${estimateLine}` }));
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
