#!/usr/bin/env node
// Reports, for the CURRENT Claude Code session, every time one of this
// plugin's three cost-gate hooks fired (UserPromptSubmit / prompts,
// UserPromptExpansion / slash commands, PreToolUse:ExitPlanMode / plans)
// — blocked, confirmed, or purely informational — AND every prompt/
// command/plan this session that had NO hook record at all. The second
// half is the point: informational hook messages render with zero
// visible UI feedback in some Claude Code hosts, so this is the only way
// to retroactively answer "did the gate actually see this."
//
// Companion to usage-estimate-session.cjs (which reports ACTUAL API cost,
// mined from token usage) — this script reports GATE ACTIVITY instead,
// parsed from how Claude Code logs hook output into the session
// transcript. Read-only: never touches pending-cost-confirmations.json or
// any other persisted state, no network calls.
//
// Real JSONL shapes this parser depends on (confirmed by grepping an
// actual transcript, not guessed from docs — none exist for this level
// of detail):
//   Blocked:  {"type":"system","subtype":"informational","content":
//     "<HookEventName> operation blocked by hook:\n<estimate line>...
//     \n\nOriginal <prompt|command>: <text>"}
//   Informational/confirmed: {"type":"attachment","attachment":
//     {"type":"hook_system_message","content":"<estimate line>",
//     "hookName":"UserPromptSubmit"|"UserPromptExpansion"|
//     "PreToolUse:ExitPlanMode","toolUseID":"...","hookEvent":"..."}}
//     A confirmed resend has the identical shape, content prefixed
//     "✅ Confirmed — proceeding. ".
// There is NO shared id field between a blocked record and its later
// confirm — the only correlation signal is identical bucket/token/cost
// numbers (both estimate the exact same resent text) within the 5-minute
// confirm window, matched chronologically. This is an inherent limitation
// of the only signal available, not a design choice: two different blocks
// that happen to produce identical numbers could theoretically be
// mismatched, though in practice the token/cost figures are precise
// enough that this is very unlikely.
//
// KNOWN LIMITATION, confirmed by direct inspection: a slash command typed
// with its arguments pasted across multiple lines (rather than on the same
// line) can get routed by Claude Code as a plain UserPromptSubmit prompt
// instead of a true UserPromptExpansion command expansion — the raw text
// just happens to start with "/command-name". A <command-name> tag in the
// transcript is reliable evidence the command syntax was recognized, but
// its absence of a matching "command" hook record doesn't always mean the
// gate missed it — the SAME interaction may have real coverage recorded
// under "prompt" instead. This script does not attempt to cross-correlate
// across categories for this case (unreliable, and the affected shape is
// an unusual paste pattern, not typical single-line command usage) — read
// a "command" no-record item's reason as a hint to check the "prompt"
// timeline for the same timestamp, not a guaranteed gap.
//
// For "no gate record" prompts (4+ words) and resolvable commands, this
// script ALSO re-estimates the cost right now via the same estimator the
// real hooks use, and reports whether it would cross the confirm
// threshold — a would-block item is a genuine anomaly worth investigating
// (the gate should have caught it), while an under-threshold one is
// expected and harmless (it was never going to gate anything, just
// invisible in this host's UI same as every other informational message).
// This uses CURRENT model/threshold/weights config, not necessarily what
// was active when the event actually happened — a live re-check, not a
// historical record.
//
// Usage: node hook-activity-report.cjs [--cwd <path>] [--json] [--html <path>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveCommandContent } = require('./lib/resolve-command-content.cjs');
const loadGlobals = require('./lib/load-globals.cjs');

const CONFIRM_WINDOW_MS = 5 * 60 * 1000; // duplicated from scripts/lib/confirm-gate.cjs's CONFIRM_WINDOW_MS — this script never requires that module, since everything needed here already lives in the transcript itself.
const RAW_EVENT_MATCH_WINDOW_MS = 2000; // hook records land within ~1s of their triggering event in practice; generous margin.

// Same project-directory naming + "most-recently-modified *.jsonl" heuristic
// as usage-estimate-session.cjs (duplicated — that script exports nothing,
// and this plugin's hook scripts already each carry their own small-helper
// copies rather than sharing a lib for things this size).
function projectSlugFor(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

function findCurrentSessionFile(cwd) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const dir = path.join(projectsDir, projectSlugFor(cwd));
  if (!fs.existsSync(dir)) return null;
  let best = null;
  let bestMtime = -1;
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.jsonl')) continue;
    const full = path.join(dir, name);
    const mtime = fs.statSync(full).mtimeMs;
    if (mtime > bestMtime) { bestMtime = mtime; best = full; }
  }
  return best;
}

// Adapted (not called) from mine-session-data.cjs's SYNTHETIC_PREFIXES —
// that function's own filter discards <command-name> text entirely, but
// this script needs to keep it (as a distinct "command" raw event, handled
// separately below), so the list is copied here minus that one entry.
const SYNTHETIC_PREFIXES = [
  '<ide_opened_file>', '<ide_selection>', '<command-message>',
  '<local-command-stdout', '<system-reminder>', '<task-notes>', 'Caveat:',
  '[Request interrupted',
  "Run the current Claude Code session's actual-vs-estimated cost report",
  'Base directory for this skill:', // command-body expansion text — see the timestamp-based filter below for the primary defense
];
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/;

function messageText(message) {
  const content = message && message.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    if (content.some((c) => c.type === 'tool_result')) return null;
    const parts = content.filter((c) => c.type === 'text').map((c) => c.text || '');
    return parts.join('\n');
  }
  return null;
}

const BLOCK_PREFIX_RE = /^(\S+) operation blocked by hook:\n([\s\S]*)$/;
const ORIGINAL_RE = /\n\nOriginal (?:prompt|command|text):\s*([\s\S]*)$/;
const BUCKET_RE = /bucket\s+(\w+)\s*·/;
const NUMBERS_RE = /~([\d.,]+[kM]?)[–-]([\d.,]+[kM]?)\s+tokens,\s*\$([\d.,]+)[–-]\$([\d.,]+)/;
const CONFIRMED_PREFIX = '✅ Confirmed — proceeding. ';

function categoryForHookName(hookName) {
  if (hookName === 'UserPromptSubmit') return 'prompt';
  if (hookName === 'UserPromptExpansion') return 'command';
  if (hookName === 'PreToolUse:ExitPlanMode') return 'plan';
  return 'unknown';
}

function extractNumbers(text) {
  const bucketMatch = BUCKET_RE.exec(text);
  const numMatch = NUMBERS_RE.exec(text);
  return {
    bucket: bucketMatch ? bucketMatch[1] : null,
    tokenLow: numMatch ? numMatch[1] : null,
    tokenHigh: numMatch ? numMatch[2] : null,
    costLow: numMatch ? '$' + numMatch[3] : null,
    costHigh: numMatch ? '$' + numMatch[4] : null,
  };
}

function signatureFor(rec) {
  return [rec.category, rec.bucket, rec.tokenLow, rec.tokenHigh, rec.costLow, rec.costHigh].join('|');
}

function truncate(s, n) {
  if (!s) return s;
  const t = s.trim().replace(/\s+/g, ' ');
  return t.length > n ? t.slice(0, n - 1) + '…' : t;
}

function parseSession(file, cwd) {
  const hookRecords = []; // {kind:'blocked'|'informational', category, status, timestamp, bucket, tokenLow, tokenHigh, costLow, costHigh, textPreview}
  const rawEvents = []; // {kind:'prompt'|'command'|'plan', timestamp, text/commandName/commandArgs/toolUseId, cwd}

  const lines = fs.readFileSync(file, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }

    if (e.type === 'system' && e.subtype === 'informational' && typeof e.content === 'string') {
      const m = BLOCK_PREFIX_RE.exec(e.content);
      if (m) {
        const category = categoryForHookName(m[1]);
        const rest = m[2];
        const origMatch = ORIGINAL_RE.exec(rest);
        let reasonText = rest;
        let originalText = null;
        if (origMatch) {
          reasonText = rest.slice(0, origMatch.index);
          originalText = origMatch[1];
        } else {
          const parts = rest.split(/\n\n/);
          reasonText = parts[0];
          originalText = parts.length > 1 ? parts.slice(1).join('\n\n') : null;
        }
        const nums = extractNumbers(reasonText);
        hookRecords.push({
          kind: 'blocked', category, status: 'blocked', timestamp: e.timestamp,
          ...nums, textPreview: truncate(originalText || reasonText, 140),
        });
      }
      continue;
    }

    if (e.type === 'attachment' && e.attachment && e.attachment.type === 'hook_system_message') {
      const a = e.attachment;
      const category = categoryForHookName(a.hookName);
      const confirmed = typeof a.content === 'string' && a.content.startsWith(CONFIRMED_PREFIX);
      const nums = extractNumbers(a.content || '');
      hookRecords.push({
        kind: 'informational', category, status: confirmed ? 'confirmed' : 'informational',
        timestamp: e.timestamp, ...nums, textPreview: truncate(a.content, 140),
        toolUseId: a.toolUseID || null,
      });
      continue;
    }

    if (e.type === 'user' && !e.isSidechain) {
      const text = messageText(e.message);
      if (text == null) continue;
      const cmdMatch = /<command-name>([^<]*)<\/command-name>/.exec(text);
      if (cmdMatch) {
        const argsMatch = /<command-args>([\s\S]*?)<\/command-args>/.exec(text);
        rawEvents.push({
          kind: 'command', timestamp: e.timestamp,
          // <command-name> in the transcript includes the leading "/" —
          // the real UserPromptExpansion hook payload's command_name field
          // does NOT (confirmed via the earlier debug-hook capture this
          // session), so strip it here to match what resolveCommandContent
          // and the exemption check both expect.
          commandName: cmdMatch[1].trim().replace(/^\//, ''),
          commandArgs: argsMatch ? argsMatch[1] : '',
          cwd: e.cwd || cwd,
        });
        continue;
      }
      const trimmed = text.trim();
      if (!trimmed) continue;
      if (SYNTHETIC_PREFIXES.some((p) => trimmed.startsWith(p)) || ANSI_ESCAPE.test(trimmed)) continue;
      rawEvents.push({ kind: 'prompt', timestamp: e.timestamp, text: trimmed });
      continue;
    }

    if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
      for (const c of e.message.content) {
        if (c && c.type === 'tool_use' && c.name === 'ExitPlanMode') {
          rawEvents.push({
            kind: 'plan', timestamp: e.timestamp, toolUseId: c.id,
            text: (c.input && c.input.plan) || null,
          });
        }
      }
    }
  }

  // A command's own expanded skill-body text lands as a SEPARATE type:user
  // message sharing the exact same timestamp as its <command-name> event
  // (confirmed: e.g. "/insights" and its "The user just ran /insights..."
  // context payload both timestamped 04:56:47.094Z) — it's not an
  // independent human-typed prompt UserPromptSubmit would ever see, so
  // drop any 'prompt' raw event whose timestamp exactly matches a
  // 'command' raw event's, or it falsely reports as gate-uncovered.
  const commandTimestamps = new Set(rawEvents.filter((e) => e.kind === 'command').map((e) => e.timestamp));
  const filteredEvents = rawEvents.filter((e) => !(e.kind === 'prompt' && commandTimestamps.has(e.timestamp)));

  return { hookRecords, rawEvents: filteredEvents };
}

function classify(hookRecords, rawEvents, cwd) {
  const timeline = [];
  const summary = {
    prompt: { blocked: 0, confirmed: 0, pending: 0, abandoned: 0, superseded: 0, informational: 0, noRecord: 0, noRecordWouldBlock: 0, noRecordUnderThreshold: 0 },
    command: { blocked: 0, confirmed: 0, pending: 0, abandoned: 0, superseded: 0, informational: 0, noRecord: 0, noRecordWouldBlock: 0, noRecordUnderThreshold: 0 },
    plan: { informational: 0, noRecord: 0 },
  };
  const now = Date.now();
  const claimedConfirms = new Set();

  // Same estimator/config the real hooks use — loaded once, reused for
  // every no-record re-estimate below. Loading is cheap (a vm-loaded
  // local model, no network), so unconditional is simpler than lazy-init
  // for the common case where at least one no-record item needs it.
  const g = loadGlobals({ withWeights: true });
  const modelKey = process.env.CLAUDE_CODE_PLAN_ESTIMATE_MODEL || 'sonnet';
  const threshold = parseFloat(process.env.CLAUDE_CODE_PROMPT_COST_CONFIRM_THRESHOLD || '0.50');

  // Plain informational (not blocked, not confirmed) — prompt/command, and
  // all plan records (plans never block).
  for (const rec of hookRecords) {
    if (rec.status === 'informational') {
      const bucket = summary[rec.category];
      if (bucket) bucket.informational++;
      timeline.push({ kind: 'informational', category: rec.category, timestamp: rec.timestamp,
        outcome: null, textPreview: rec.textPreview, bucket: rec.bucket, tokenLow: rec.tokenLow,
        tokenHigh: rec.tokenHigh, costLow: rec.costLow, costHigh: rec.costHigh, toolUseId: rec.toolUseId || null });
    }
  }

  // Blocks — group by signature, only the last per group is "live".
  const blocked = hookRecords.filter((r) => r.kind === 'blocked' && (r.category === 'prompt' || r.category === 'command'));
  const groups = new Map();
  for (const rec of blocked) {
    const sig = signatureFor(rec);
    if (!groups.has(sig)) groups.set(sig, []);
    groups.get(sig).push(rec);
  }
  const confirmedPool = hookRecords.filter((r) => r.status === 'confirmed');
  for (const [sig, group] of groups) {
    group.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    for (let i = 0; i < group.length; i++) {
      const rec = group[i];
      const isLast = i === group.length - 1;
      if (!isLast) {
        summary[rec.category].superseded++;
        timeline.push({ kind: 'blocked', category: rec.category, timestamp: rec.timestamp,
          outcome: 'superseded', textPreview: rec.textPreview, bucket: rec.bucket,
          tokenLow: rec.tokenLow, tokenHigh: rec.tokenHigh, costLow: rec.costLow, costHigh: rec.costHigh });
        continue;
      }
      const blockTimeMs = Date.parse(rec.timestamp);
      let match = null;
      for (const cand of confirmedPool) {
        if (claimedConfirms.has(cand)) continue;
        if (cand.category !== rec.category || signatureFor(cand) !== sig) continue;
        const candTimeMs = Date.parse(cand.timestamp);
        if (candTimeMs > blockTimeMs && candTimeMs - blockTimeMs <= CONFIRM_WINDOW_MS) { match = cand; break; }
      }
      let outcome;
      if (match) { claimedConfirms.add(match); outcome = 'confirmed'; }
      else if (now - blockTimeMs < CONFIRM_WINDOW_MS) outcome = 'pending';
      else outcome = 'abandoned';
      summary[rec.category][outcome]++;
      timeline.push({ kind: 'blocked', category: rec.category, timestamp: rec.timestamp,
        outcome, linkedTimestamp: match ? match.timestamp : null, textPreview: rec.textPreview,
        bucket: rec.bucket, tokenLow: rec.tokenLow, tokenHigh: rec.tokenHigh, costLow: rec.costLow, costHigh: rec.costHigh });
    }
  }
  // Confirmed records not claimed by any block shouldn't happen in practice
  // (a confirm always follows a block by design) but surface them plainly
  // rather than silently dropping if it ever does.
  for (const rec of confirmedPool) {
    if (claimedConfirms.has(rec)) continue;
    summary[rec.category].confirmed++;
    timeline.push({ kind: 'confirmed', category: rec.category, timestamp: rec.timestamp,
      outcome: 'confirmed', textPreview: rec.textPreview, bucket: rec.bucket,
      tokenLow: rec.tokenLow, tokenHigh: rec.tokenHigh, costLow: rec.costLow, costHigh: rec.costHigh });
  }

  // Raw event <-> hook record coverage check ("no-record" detection).
  function hasNearbyRecord(category, tsIso) {
    const t = Date.parse(tsIso);
    return hookRecords.some((r) => r.category === category && Math.abs(Date.parse(r.timestamp) - t) <= RAW_EVENT_MATCH_WINDOW_MS);
  }

  for (const ev of rawEvents) {
    if (ev.kind === 'plan') {
      const hasRecord = hookRecords.some((r) => r.category === 'plan' && r.toolUseId === ev.toolUseId);
      if (!hasRecord) {
        summary.plan.noRecord++;
        timeline.push({ kind: 'no-record', category: 'plan', timestamp: ev.timestamp,
          textPreview: truncate(ev.text, 140), reason: 'plan-cost-estimate hook produced no record — possible gate failure' });
      }
      continue;
    }
    if (ev.kind === 'prompt') {
      if (hasNearbyRecord('prompt', ev.timestamp)) continue;
      const wordCount = ev.text.split(/\s+/).filter(Boolean).length;
      let reason, wouldExceedThreshold = null, estCostHigh = null;
      if (wordCount < 4) {
        reason = 'too short — skipped by design';
      } else {
        const est = g.estimateTask(ev.text, modelKey, { agentic: true });
        wouldExceedThreshold = est.costHigh > threshold;
        estCostHigh = est.costHigh;
        reason = wouldExceedThreshold
          ? `re-estimating now: $${est.costHigh.toFixed(2)} exceeds the $${threshold.toFixed(2)} threshold — the gate should have blocked this, worth investigating`
          : `re-estimating now: $${est.costHigh.toFixed(2)} is under the $${threshold.toFixed(2)} threshold — correctly informational-only, likely just invisible in this host's UI`;
      }
      summary.prompt.noRecord++;
      if (wouldExceedThreshold === true) summary.prompt.noRecordWouldBlock++;
      if (wouldExceedThreshold === false) summary.prompt.noRecordUnderThreshold++;
      timeline.push({ kind: 'no-record', category: 'prompt', timestamp: ev.timestamp,
        textPreview: truncate(ev.text, 140), reason, wouldExceedThreshold, estCostHigh });
      continue;
    }
    if (ev.kind === 'command') {
      if (hasNearbyRecord('command', ev.timestamp)) continue;
      let reason, resolvesToday = null, wouldExceedThreshold = null, estCostHigh = null;
      if (ev.commandName.startsWith('prompt-cost-preview:')) {
        reason = 'exempt by design (this plugin’s own commands)';
      } else {
        const content = resolveCommandContent({ command_name: ev.commandName, cwd: ev.cwd || cwd });
        resolvesToday = content != null;
        if (resolvesToday) {
          const text = (content + (ev.commandArgs ? '\n' + ev.commandArgs : '')).trim();
          const est = g.estimateTask(text, modelKey, { agentic: true });
          wouldExceedThreshold = est.costHigh > threshold;
          estCostHigh = est.costHigh;
          reason = wouldExceedThreshold
            ? `re-estimating now: $${est.costHigh.toFixed(2)} exceeds the $${threshold.toFixed(2)} threshold — the gate should have blocked this, worth investigating`
            : `re-estimating now: $${est.costHigh.toFixed(2)} is under the $${threshold.toFixed(2)} threshold — correctly informational-only, likely just invisible in this host's UI`;
        } else {
          reason = 'not resolvable today (host-bundled or missing source)';
        }
      }
      summary.command.noRecord++;
      if (wouldExceedThreshold === true) summary.command.noRecordWouldBlock++;
      if (wouldExceedThreshold === false) summary.command.noRecordUnderThreshold++;
      timeline.push({ kind: 'no-record', category: 'command', timestamp: ev.timestamp,
        commandName: ev.commandName, resolvesToday, wouldExceedThreshold, estCostHigh,
        textPreview: truncate(ev.commandArgs, 140), reason });
    }
  }

  timeline.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  return { summary, timeline };
}

function colorHelpers() {
  const useColor = process.stdout.isTTY;
  const wrap = (code) => (s) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
  return { bold: wrap(1), dim: wrap(2), red: wrap(31), yellow: wrap(33), green: wrap(32) };
}

function printConsole(reportData) {
  const { bold, dim, red, yellow, green } = colorHelpers();
  console.log(bold('Hook Activity'));
  console.log(dim(`Session ${reportData.sessionId}`));
  console.log('');
  const SUB_KEYS = new Set(['noRecordWouldBlock', 'noRecordUnderThreshold']);
  for (const cat of ['prompt', 'command', 'plan']) {
    const s = reportData.summary[cat];
    const parts = Object.entries(s).filter(([k, v]) => v > 0 && !SUB_KEYS.has(k)).map(([k, v]) => {
      if (k === 'noRecord' && (s.noRecordWouldBlock || s.noRecordUnderThreshold)) {
        return `${k}: ${v} (${s.noRecordWouldBlock} would-block, ${s.noRecordUnderThreshold} under-threshold)`;
      }
      return `${k}: ${v}`;
    });
    console.log(bold(cat.charAt(0).toUpperCase() + cat.slice(1) + 's') + '  ' + (parts.length ? parts.join(', ') : dim('none')));
  }
  console.log('');

  const needsAttention = reportData.timeline.filter((t) => t.outcome === 'pending' || t.outcome === 'abandoned' || t.wouldExceedThreshold === true);
  if (needsAttention.length) {
    console.log(bold('Needs attention'));
    for (const t of needsAttention) {
      const label = t.wouldExceedThreshold === true ? red('WOULD BLOCK') : t.outcome === 'pending' ? yellow('PENDING') : red('ABANDONED');
      console.log(`  ${label}  [${t.category}]  ${t.timestamp}  ${t.commandName || t.textPreview}`);
    }
    console.log('');
  }

  const noRecord = reportData.timeline.filter((t) => t.kind === 'no-record');
  if (noRecord.length) {
    console.log(bold('No gate record'));
    for (const t of noRecord) {
      console.log(`  ${dim('—')}  [${t.category}]  ${t.timestamp}  ${t.commandName || t.textPreview || ''}`);
      console.log(`      ${dim(t.reason)}`);
    }
    console.log('');
  }

  console.log(dim(`${reportData.timeline.length} total events — run with --json for the full timeline, --html for a shareable report card.`));
  console.log(dim('Note: a "command" no-record item may actually be covered under "prompt" — see this script\'s header comment.'));
}

function escapeHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function chipFor(item) {
  if (item.kind === 'no-record') {
    if (item.wouldExceedThreshold === true) return { cls: 'chip-bad', label: 'NO RECORD · WOULD BLOCK' };
    if (item.wouldExceedThreshold === false) return { cls: 'chip-norecord', label: 'NO RECORD · OK' };
    return { cls: 'chip-norecord', label: 'NO RECORD' };
  }
  if (item.kind === 'blocked') {
    if (item.outcome === 'confirmed') return { cls: 'chip-good', label: 'CONFIRMED' };
    if (item.outcome === 'pending') return { cls: 'chip-warn', label: 'PENDING' };
    if (item.outcome === 'superseded') return { cls: 'chip-warn', label: 'SUPERSEDED' };
    return { cls: 'chip-bad', label: 'ABANDONED' };
  }
  if (item.status === 'confirmed' || item.kind === 'confirmed') return { cls: 'chip-good', label: 'CONFIRMED' };
  return { cls: 'chip-good', label: 'INFORMATIONAL' };
}

function renderHtml(reportData) {
  const rows = reportData.timeline.map((t) => {
    const chip = chipFor(t);
    const numbers = t.tokenLow ? `${t.bucket ? 'bucket ' + escapeHtml(t.bucket) + ' &middot; ' : ''}~${escapeHtml(t.tokenLow)}&ndash;${escapeHtml(t.tokenHigh)} tokens, ${escapeHtml(t.costLow)}&ndash;${escapeHtml(t.costHigh)}` : (t.reason ? escapeHtml(t.reason) : '');
    const label = t.commandName ? '/' + escapeHtml(t.commandName) : escapeHtml(t.textPreview || '');
    return `<div class="event"><span class="chip ${chip.cls}">${chip.label}</span><div class="event-body"><div class="event-cat">${escapeHtml(t.category)} &middot; ${escapeHtml(t.timestamp)}</div><div class="event-label">${label}</div><div class="event-numbers">${numbers}</div></div></div>`;
  }).join('\n');

  const SUB_KEYS = new Set(['noRecordWouldBlock', 'noRecordUnderThreshold']);
  const statCells = ['prompt', 'command', 'plan'].map((cat) => {
    const s = reportData.summary[cat];
    const parts = Object.entries(s).filter(([k, v]) => v > 0 && !SUB_KEYS.has(k)).map(([k, v]) => {
      const suffix = (k === 'noRecord' && (s.noRecordWouldBlock || s.noRecordUnderThreshold))
        ? ` (${s.noRecordWouldBlock} would-block, ${s.noRecordUnderThreshold} under)` : '';
      return `${k}: <span class="num">${v}</span>${suffix}`;
    }).join(' &middot; ');
    return `<div class="stat"><span class="stat-label">${cat}s</span><span class="stat-value">${parts || '<span class="dim">none</span>'}</span></div>`;
  }).join('\n');

  return `<title>Hook Activity</title>
<style>
  :root {
    --bg-page: #eef0f2; --bg-card: #ffffff; --border: rgba(15,15,17,0.09); --border-strong: rgba(15,15,17,0.14);
    --text-primary: #1a1a1d; --text-secondary: #6b6b70; --text-tertiary: #9a9aa0;
    --accent-good: #1c8a4b; --accent-good-bg: rgba(28,138,75,0.12);
    --accent-warn: #b25a00; --accent-warn-bg: rgba(178,90,0,0.12);
    --accent-bad: #c22e2e; --accent-bad-bg: rgba(194,46,46,0.12);
    --shadow: 0 1px 2px rgba(15,15,17,0.04), 0 12px 32px -16px rgba(15,15,17,0.18);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-page: #0a0a0b; --bg-card: #1c1c1e; --border: rgba(255,255,255,0.08); --border-strong: rgba(255,255,255,0.14);
      --text-primary: #f5f5f7; --text-secondary: #8e8e93; --text-tertiary: #6a6a6e;
      --accent-good: #34c759; --accent-good-bg: rgba(52,199,89,0.16);
      --accent-warn: #ff9f0a; --accent-warn-bg: rgba(255,159,10,0.16);
      --accent-bad: #ff453a; --accent-bad-bg: rgba(255,69,58,0.16);
      --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 20px 48px -20px rgba(0,0,0,0.6);
    }
  }
  :root[data-theme="dark"] {
    --bg-page: #0a0a0b; --bg-card: #1c1c1e; --border: rgba(255,255,255,0.08); --border-strong: rgba(255,255,255,0.14);
    --text-primary: #f5f5f7; --text-secondary: #8e8e93; --text-tertiary: #6a6a6e;
    --accent-good: #34c759; --accent-good-bg: rgba(52,199,89,0.16);
    --accent-warn: #ff9f0a; --accent-warn-bg: rgba(255,159,10,0.16);
    --accent-bad: #ff453a; --accent-bad-bg: rgba(255,69,58,0.16);
  }
  :root[data-theme="light"] {
    --bg-page: #eef0f2; --bg-card: #ffffff; --border: rgba(15,15,17,0.09); --border-strong: rgba(15,15,17,0.14);
    --text-primary: #1a1a1d; --text-secondary: #6b6b70; --text-tertiary: #9a9aa0;
    --accent-good: #1c8a4b; --accent-good-bg: rgba(28,138,75,0.12);
    --accent-warn: #b25a00; --accent-warn-bg: rgba(178,90,0,0.12);
    --accent-bad: #c22e2e; --accent-bad-bg: rgba(194,46,46,0.12);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center;
    padding: 48px 20px; background: var(--bg-page);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    color: var(--text-primary); -webkit-font-smoothing: antialiased;
  }
  .num { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; }
  .dim { color: var(--text-tertiary); }
  .card { width: 100%; max-width: 620px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow); padding: 28px 26px 24px; }
  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-tertiary); margin: 0 0 4px; }
  h1 { font-size: 22px; font-weight: 650; letter-spacing: -0.015em; margin: 0; }
  .session-meta { margin: 6px 0 0; font-size: 13px; color: var(--text-secondary); }
  .divider { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
  h2 { font-size: 13px; font-weight: 650; margin: 0 0 12px; color: var(--text-primary); }
  .stat-row { display: flex; flex-direction: column; gap: 8px; }
  .stat { display: flex; justify-content: space-between; font-size: 13px; }
  .stat-label { color: var(--text-secondary); text-transform: capitalize; }
  .stat-value { color: var(--text-primary); }
  .event-list { display: flex; flex-direction: column; gap: 10px; max-height: 520px; overflow-y: auto; }
  .event { display: flex; gap: 10px; align-items: flex-start; padding: 10px; border: 1px solid var(--border); border-radius: 10px; }
  .chip { flex-shrink: 0; font-size: 10px; font-weight: 700; letter-spacing: 0.04em; padding: 3px 7px; border-radius: 6px; margin-top: 1px; white-space: nowrap; }
  .chip-good { background: var(--accent-good-bg); color: var(--accent-good); }
  .chip-warn { background: var(--accent-warn-bg); color: var(--accent-warn); }
  .chip-bad { background: var(--accent-bad-bg); color: var(--accent-bad); }
  .chip-norecord { background: transparent; color: var(--text-tertiary); border: 1px dashed var(--border-strong); }
  .event-body { min-width: 0; flex: 1; }
  .event-cat { font-size: 10px; text-transform: uppercase; letter-spacing: 0.04em; color: var(--text-tertiary); }
  .event-label { font-size: 13px; color: var(--text-primary); margin-top: 2px; word-break: break-word; }
  .event-numbers { font-size: 12px; color: var(--text-secondary); margin-top: 2px; }
  .footer { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-tertiary); line-height: 1.6; }
</style>

<div class="card">
  <p class="eyebrow">Claude Code &middot; prompt-cost-preview</p>
  <h1>Hook Activity</h1>
  <p class="session-meta">Session <span class="num">${escapeHtml(reportData.sessionId.slice(0, 8))}</span> &middot; generated ${escapeHtml(reportData.generatedAt)}</p>

  <hr class="divider" />
  <h2>Summary</h2>
  <div class="stat-row">
    ${statCells}
  </div>

  <hr class="divider" />
  <h2>Timeline (${reportData.timeline.length})</h2>
  <div class="event-list">
    ${rows || '<div class="dim">No hook activity or gate-covered events found this session.</div>'}
  </div>

  <div class="footer">Read-only report of this plugin's cost-gate hooks for this session only. Never touches pending-cost-confirmations.json or any other persisted state. No network calls. A "command" no-record item may actually be covered under "prompt" if its arguments were pasted across multiple lines &mdash; Claude Code can route that as a plain prompt instead of a true command expansion.</div>
</div>
`;
}

function main() {
  const args = process.argv.slice(2);
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx !== -1 ? args[cwdIdx + 1] : process.cwd();
  const jsonMode = args.includes('--json');
  const htmlIdx = args.indexOf('--html');

  const file = findCurrentSessionFile(cwd);
  if (!file) {
    console.error(`No session transcript found for ${cwd}`);
    process.exit(1);
  }

  const { hookRecords, rawEvents } = parseSession(file, cwd);
  const { summary, timeline } = classify(hookRecords, rawEvents, cwd);
  const reportData = {
    sessionId: path.basename(file, '.jsonl'),
    generatedAt: new Date().toISOString(),
    windowMs: CONFIRM_WINDOW_MS,
    summary,
    timeline,
  };

  if (htmlIdx !== -1) {
    const outPath = args[htmlIdx + 1];
    fs.writeFileSync(outPath, renderHtml(reportData));
    console.log(`Wrote ${outPath}`);
    return;
  }
  if (jsonMode) {
    console.log(JSON.stringify(reportData, null, 2));
    return;
  }
  printConsole(reportData);
}

main();
