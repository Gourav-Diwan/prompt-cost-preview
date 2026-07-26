# AI Usage Estimate

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
  again (for longer prompts) right as you submit a regular message. Both
  are informational only — they never block or erase what you typed.
- **`retrain` skill** — mines every Claude Code session on this machine,
  trains a personalized copy of the cost model on it, and every other
  part of this plugin picks it up automatically afterward.

## Install

```
/plugin marketplace add Gourav-Diwan/ai-usage-estimate
/plugin install ai-usage-estimate@ai-usage-estimate
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
persistent data directory — nothing leaves your machine at any point.
