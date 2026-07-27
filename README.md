# Prompt Cost Preview

A Claude Code plugin that estimates the token/dollar cost of your prompts
and plans before they run, compares actual-vs-estimated cost for the
current session (alongside the built-in `/usage` command), and can
retrain itself on your own session history for a personalized estimate.

**No network calls. No data leaves your machine.** Everything runs
locally against your own `~/.claude/projects/**` transcripts.

## What it does

- **`usage-estimate` skill** — actual-vs-estimated cost for the current
  session, plus a styled shareable report card.
- **Cost feedback before you run something** — a message shows the
  estimated cost right before Plan Mode's approve/reject prompt, and
  again (for longer prompts) right as you submit a regular message.
  Plan Mode's estimate is always informational only. The regular-prompt
  estimate is informational too, *unless* its high-end cost estimate is
  above `CLAUDE_CODE_PROMPT_COST_CONFIRM_THRESHOLD` (default `$0.50`) — in
  that case the prompt is blocked with the estimate shown as the reason,
  and you resend the exact same prompt within 5 minutes to confirm and let
  it proceed. (`UserPromptSubmit` hooks can't pause and wait for a
  yes/no click, so a literal resend is the confirmation gesture.)
- **The same gate applies to slash commands** (`/name` or `/plugin:name`),
  not just typed prompts — estimated against the command's own instruction
  file, same `$0.50` threshold and resend-to-confirm mechanic. This only
  works for commands whose source file this plugin can actually locate on
  disk (installed-plugin `skills/`/`commands/` layouts, and project-/
  user-level `.claude/skills/`/`.claude/commands/`); a command from a
  source or layout this plugin doesn't recognize is estimated as "no data"
  and passes through ungated, same as anything under threshold. This
  plugin's own `usage-estimate`/`retrain` commands are exempt from their
  own gate.
- **`retrain` skill** — mines every Claude Code session on this machine,
  trains a personalized copy of the cost model on it, and every other
  part of this plugin picks it up automatically afterward.
- **`hook-activity` skill** — since informational (non-blocking) cost
  messages render with zero visible UI feedback in some Claude Code
  hosts, this reviews the whole session at once: every blocked,
  confirmed, and informational gate message across prompts/commands/
  plans, plus a "no gate record" list for anything the gates never saw
  at all (e.g. a host-bundled skill this plugin can't locate on disk) —
  each no-record item is also re-estimated live against the real
  threshold, so it's flagged as a genuine "would block" anomaly worth
  investigating versus a harmless "under threshold, just invisible in
  this host's UI" case. All of it renders as a styled report card, same
  shareable-Artifact pattern as `usage-estimate`.

## Install

```
/plugin marketplace add Gourav-Diwan/prompt-cost-preview
/plugin install prompt-cost-preview@prompt-cost-preview
```

## Usage

- Ask Claude to show your session cost, or run the `usage-estimate` skill
  directly.
- Cost feedback for prompts and plans appears automatically once
  installed — nothing to configure.
- Run the `retrain` skill any time you want the estimate personalized to
  your own usage patterns (needs at least 200 mined rows first — keep
  using Claude Code and try again if it's not ready yet).

## Privacy

This plugin never makes a network request and never uploads anything.
The `retrain` skill reads your local `~/.claude/projects/**/*.jsonl`
transcripts and writes a personalized model file to this plugin's own
persistent data directory — nothing leaves your machine at any point. The
slash-command gate reads local command/skill markdown files (not just
prompt text and transcripts) to estimate their cost — still local-only,
just a wider local-read surface than the prompt gate alone.
