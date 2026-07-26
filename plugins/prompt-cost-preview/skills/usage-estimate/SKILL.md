---
name: usage-estimate
description: Show actual session cost (like /usage) alongside this session's estimated cost from a local heuristic/neural token-cost model, plus a styled report card
---

Run the current Claude Code session's actual-vs-estimated cost report. Do
the following steps in order, with no added commentary beyond what's
instructed:

1. **Console report** — run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-estimate-session.cjs"
   ```
   Show this output to the user verbatim.

2. **Structured data** — run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-estimate-session.cjs" --json
   ```
   This prints the same underlying `reportData` as JSON instead of the
   plain-text report — use it if you need to reference specific numbers
   (per-model costs, cache hit %, turn count) precisely rather than
   re-parsing the console text.

3. **Styled HTML report card** — write it to your scratchpad directory,
   e.g.:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/usage-estimate-session.cjs" --html <scratchpad>/usage-estimate-report.html
   ```
   Same underlying data as steps 1–2, rendered as a dark/light-themed
   report card (progress bars, estimate-vs-actual accuracy bar).

4. **Open the report as an Artifact** — publish the HTML file from step 3
   with the Artifact tool. Always publish a FRESH Artifact (do not attempt
   to update any prior URL — this plugin has no shared page to update in
   place) so each run gets its own shareable link, and pass
   `favicon: "📊"`.

After all four steps, reply with the console output from step 1 followed
by one line linking the fresh report from step 4 — no other commentary.

This estimate uses a local model bundled with this plugin — no network
calls, no data leaves your machine. If you've run the `retrain` skill,
estimates reflect your own personalized model instead of the shared base
model.
