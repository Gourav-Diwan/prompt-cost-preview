// Shared cost-confirm gate, extracted from prompt-cost-estimate.cjs so
// command-cost-estimate.cjs (UserPromptExpansion) can reuse the exact same
// hash/threshold/state-file/block-or-confirm-or-inform logic instead of a
// second hand-synced copy. Both hooks read/write the SAME
// ${CLAUDE_PLUGIN_DATA}/pending-cost-confirmations.json — intentional
// shared state (a hash collision between a typed prompt and a
// "/plugin:name args" string isn't a real risk) — don't split this into
// two files later.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIRM_WINDOW_MS = 5 * 60 * 1000;

// Reads/prunes/writes the pending-confirmation map. Never throws — a
// corrupt or unwritable state file must degrade to "no confirmations
// pending" (i.e. the next expensive prompt/command just re-blocks), never
// crash the hook or wedge submission.
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

// confirmGate({ textToHash, estimateLine, costHigh, threshold, dataDir,
//   subjectLabel }) -> plain object ready for JSON.stringify. Never throws.
function confirmGate({ textToHash, estimateLine, costHigh, threshold, dataDir, subjectLabel = 'prompt' }) {
  try {
    if (dataDir && Number.isFinite(threshold) && costHigh > threshold) {
      const hash = crypto.createHash('sha256').update(textToHash).digest('hex');
      const { file, map } = loadPendingConfirmations(dataDir);

      if (map[hash]) {
        // A confirmed resend within the window — single-use, so it can't
        // be replayed again after this.
        delete map[hash];
        savePendingConfirmations(file, map);
        return { systemMessage: `✅ Confirmed — proceeding. ${estimateLine}` };
      }

      map[hash] = Date.now();
      savePendingConfirmations(file, map);
      return {
        decision: 'block',
        reason:
          `📊 ${estimateLine} This is above your $${threshold.toFixed(2)} confirm threshold. ` +
          `Resend this exact same ${subjectLabel} within 5 minutes to confirm and proceed.`,
      };
    }

    return { systemMessage: `📊 ${estimateLine}` };
  } catch {
    // A broken confirm-gate (e.g. unwritable state dir) must still surface
    // the estimate informationally, not go silent or block unrecoverably.
    return { systemMessage: `📊 ${estimateLine}` };
  }
}

module.exports = { confirmGate };
