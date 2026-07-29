# Changelog

Notable changes to this plugin. Started 2026-07-29 — earlier work isn't
individually dated, just grouped under "Before this file existed" below.
Going forward, every PR merged into `main` gets its own entry here.

## [Unreleased] — this PR
- Adds this `CHANGELOG.md`.
- Fixes a real bug: `UserPromptSubmit` also fires on Claude Code's own
  system-generated events, not just human-typed text — a background-agent
  completion notification wrapped in `<task-notification>...</task-
  notification>` was getting delivered through the same channel as a real
  prompt, with no distinguishing field. The gate was blocking these as if
  the user had typed them, leaving nothing to "resend" since the user had
  typed nothing. Fixed by adding `<task-notification>` to the
  `SYNTHETIC_PREFIXES` filter in `prompt-cost-estimate.cjs` (previously had
  no synthetic-content filtering at all). Root-caused by grepping a
  different project's real session transcript, not guessed. (`a39594c`)
- Restructures the block `reason` text (shared by both hooks, in
  `confirm-gate.cjs`) into three explicit choices — **Proceed** / **Abandon**
  / **Edit-New** — instead of one run-on sentence, per user feedback that
  the original wording read as a dead end. Real interactive buttons are
  confirmed not possible for `UserPromptSubmit`/`UserPromptExpansion` — no
  button API exists for either event, only `PreToolUse`'s
  `permissionDecision:"ask"` supports that, which is a different mechanism
  scoped to tool-call permissions.

## Before this file existed
- **`hook-activity` skill** (`19ecccc`, `fc6282f`) — a holistic per-session
  report of every prompt/command/plan cost-gate event, cross-referenced
  against every actual prompt/command/plan-approval to catch cases the
  gate never saw at all. Differentiates "would exceed the threshold, worth
  investigating" from "under threshold, just invisible in this host's UI."
- **`UserPromptExpansion` gate** (`1323c5d`) — extends the cost-confirm gate
  to slash commands, not just typed prompts. Resolves a command's own
  source file from disk since the hook payload never includes the expanded
  instruction text.
- **`UserPromptSubmit` cost-confirm gate** (`3758321`) — prompts estimated
  above `$0.50` (`CLAUDE_CODE_PROMPT_COST_CONFIRM_THRESHOLD`) block with the
  estimate as the reason; resending the identical prompt within 5 minutes
  confirms and lets it proceed. Also fixed a bug where neither hook's
  `plugin.json` command string passed `CLAUDE_PLUGIN_DATA` through, silently
  no-opping the personal-weights override.
- **Renamed** from `ai-usage-estimate` to `prompt-cost-preview` (`c71f117`).
- **Initial release** (`6a64a7b`) — actual-vs-estimated Claude Code session
  cost, cost feedback before a plan runs, and optional retraining on your
  own session data. No network calls, no data leaves your machine.
