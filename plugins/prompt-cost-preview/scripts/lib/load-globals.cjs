// Loads the plain-global estimator scripts (lib/heuristic.js and
// lib/token-model-core.js, bundled inside this plugin's own directory —
// plugins can't reference files outside themselves once installed) into a
// Node context via `vm`, so every script in this plugin uses the EXACT
// same keyword lists, featurizer, and forward pass.
//
// Adapted from equation-adventure's scripts/lib/load-globals.cjs: LIB_DIR
// points at this plugin's own bundled lib/ instead of a repo-root public/
// dir, and this version additionally applies a personal-weights override
// (see below) and can optionally load the retrain core (lib/trainer.js).
//
// Usage:
//   const g = require('./lib/load-globals.cjs')({ withWeights: true });
//   g.bucketTask(...); g.estimateTask(...); ...

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const LIB_DIR = path.join(__dirname, '..', '..', 'lib');

module.exports = function loadGlobals({ withWeights = false, withTrainer = false } = {}) {
  // setTimeout/clearTimeout: host APIs, not ECMAScript intrinsics, so a vm
  // context doesn't get them automatically — trainer.js's epoch loop yields
  // to the event loop via `await new Promise(r => setTimeout(r, 0))`
  // (originally written to keep the Chrome extension's options page
  // responsive; harmless but unnecessary overhead in a one-shot Node CLI,
  // kept as-is rather than forking trainer.js further).
  const ctx = vm.createContext({ console, Math, JSON, setTimeout, clearTimeout });
  // seed-prompts.js: chat-anchor weak-label prompts for the trainer (var
  // global, so it lands on the ctx object unlike top-level consts).
  const files = ['heuristic.js', 'token-model-core.js', 'seed-prompts.js'];
  if (withWeights) files.splice(1, 0, 'token-model-weights.js');
  for (const f of files) {
    const full = path.join(LIB_DIR, f);
    if (!fs.existsSync(full)) {
      if (f === 'token-model-weights.js' || f === 'seed-prompts.js') continue; // optional
      throw new Error(`Missing ${full}`);
    }
    vm.runInContext(fs.readFileSync(full, 'utf8'), ctx, { filename: f });
  }

  // BASE_WEIGHTS_SNAPSHOT: a frozen copy of the bundled base model, taken
  // BEFORE any personal-weights override below — trainer.js's
  // trainPersonalModel() references this bare global for its
  // personal-vs-base error comparison (same pattern
  // extension/shared/weights-loader.js already established: capture once
  // at load time, before any override touches TOKEN_MODEL_WEIGHTS).
  if (withWeights) {
    vm.runInContext(
      'var BASE_WEIGHTS_SNAPSHOT = JSON.parse(JSON.stringify(TOKEN_MODEL_WEIGHTS));',
      ctx
    );
  }

  // Personal-weights override: if a retrain has produced
  // ${CLAUDE_PLUGIN_DATA}/personal-weights.json, mutate TOKEN_MODEL_WEIGHTS
  // in place with it (same trick extension/shared/weights-loader.js uses —
  // TOKEN_MODEL_WEIGHTS is a top-level `const` inside the vm context, so it
  // can't be reassigned from outside, but its keys CAN be replaced). The
  // plugin data directory isn't substituted into Node module code (only
  // into skill/hook content), so the calling script must pass it through
  // as the CLAUDE_PLUGIN_DATA env var.
  if (withWeights && process.env.CLAUDE_PLUGIN_DATA) {
    const personalPath = path.join(process.env.CLAUDE_PLUGIN_DATA, 'personal-weights.json');
    if (fs.existsSync(personalPath)) {
      try {
        const personal = JSON.parse(fs.readFileSync(personalPath, 'utf8'));
        if (personal && Array.isArray(personal.layers)) {
          vm.runInContext(
            'function __applyPersonalWeights(w){ Object.keys(TOKEN_MODEL_WEIGHTS).forEach(function(k){ delete TOKEN_MODEL_WEIGHTS[k]; }); Object.assign(TOKEN_MODEL_WEIGHTS, w); }',
            ctx
          );
          ctx.__applyPersonalWeights(personal);
        }
      } catch {
        // Corrupt or unreadable personal-weights.json: fall back to base
        // weights silently, same fail-open contract as everywhere else in
        // this plugin's estimate path.
      }
    }
  }

  if (withTrainer) {
    const trainerFull = path.join(__dirname, 'trainer.js');
    vm.runInContext(fs.readFileSync(trainerFull, 'utf8'), ctx, { filename: 'trainer.js' });
  }

  return ctx;
};
