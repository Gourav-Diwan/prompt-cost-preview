---
name: retrain
description: Retrain the token-cost estimator on this machine's own Claude Code session history, personalizing future estimates
---

Run:
```
CLAUDE_PLUGIN_DATA="${CLAUDE_PLUGIN_DATA}" node "${CLAUDE_PLUGIN_ROOT}/scripts/retrain.cjs"
```

This mines every Claude Code session transcript on this machine
(`~/.claude/projects/**/*.jsonl`), trains a personalized copy of the
bundled cost model on them, and writes it to
`${CLAUDE_PLUGIN_DATA}/personal-weights.json` — a directory that persists
across plugin updates. Nothing leaves this machine; no network calls are
made.

Needs at least 200 real mined rows to train (the script enforces this and
reports clearly if there aren't enough yet — just keep using Claude Code
and try again later).

Report the script's own summary output back to the user in plain
language: how many rows were mined, the resulting validation loss, and
the median-error comparison between the personal model, the shared base
model, and the plain heuristic fallback (lower `×` is better — `×1` means
no error). If it fails because there aren't enough rows yet, say so
plainly and suggest trying again after more Claude Code usage, rather than
treating it as a bug.

Once this succeeds, the `usage-estimate` skill and the two cost-estimate
hooks (before a plan runs, before a regular prompt is submitted) all
automatically start reflecting the personal model — no further action or
reinstall needed.
