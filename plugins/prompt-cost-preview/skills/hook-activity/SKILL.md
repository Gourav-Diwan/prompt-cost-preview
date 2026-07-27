---
name: hook-activity
description: Review every time this session's prompt/command/plan cost gates fired — blocked, confirmed, or informational — including cases where the gate had no record at all, plus a styled report card
---

Run the current Claude Code session's hook-activity report. Do the
following steps in order, with no added commentary beyond what's
instructed:

1. **Console report** — run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-activity-report.cjs"
   ```
   Show this output to the user verbatim.

2. **Structured data** — run:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-activity-report.cjs" --json
   ```
   This prints the same underlying `reportData` as JSON instead of the
   plain-text report — use it if you need to reference specific events
   (timestamps, exact bucket/cost numbers, command resolvability)
   precisely rather than re-parsing the console text.

3. **Styled HTML report card** — write it to your scratchpad directory,
   e.g.:
   ```
   node "${CLAUDE_PLUGIN_ROOT}/scripts/hook-activity-report.cjs" --html <scratchpad>/hook-activity-report.html
   ```
   Same underlying data as steps 1–2, rendered as a dark/light-themed
   report card: summary counts per category, plus a color-coded timeline
   of every blocked / confirmed / informational / no-record event.

4. **Open the report as an Artifact** — publish the HTML file from step 3
   with the Artifact tool. Always publish a FRESH Artifact (do not attempt
   to update any prior URL — this plugin has no shared page to update in
   place) so each run gets its own shareable link, and pass
   `favicon: "🗒️"`.

After all four steps, reply with the console output from step 1 followed
by one line linking the fresh report from step 4 — no other commentary.

This report reads ONLY the current session's own transcript (and, for
slash commands, live-checks whether each command's source file is still
resolvable) — it never touches `pending-cost-confirmations.json` or any
other persisted state, and makes no network calls.

Note: a slash command whose arguments were pasted across multiple lines
can be routed by Claude Code as a plain typed prompt instead of a true
command expansion — if a command shows "no gate record," check the
prompt timeline at the same timestamp before assuming the gate missed it.
