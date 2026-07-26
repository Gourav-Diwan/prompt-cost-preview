#!/usr/bin/env node
// Mines Claude Code session transcripts (~/.claude/projects/**/*.jsonl) into
// training rows for the token-estimate neural net: one row per human prompt,
// with the REAL token usage and cost of everything the assistant did until
// the next human prompt (tool calls, subagent sidechains, all of it).
//
// This is the ground truth the manual tracker CSV can't give us — every row
// has exact input/output/cache token counts straight from the API's usage
// blocks, no self-reported actual-cost needed.
//
// Usage:
//   node scripts/mine-session-data.cjs                     # writes data/session-training-data.csv
//   node scripts/mine-session-data.cjs --stats             # mine + print summary, still writes
//   node scripts/mine-session-data.cjs --dir <path>        # override the projects dir
//   node scripts/mine-session-data.cjs --no-subagents      # skip subagent folding (see below)
//   node scripts/mine-session-data.cjs --subagent-base <p> # override the scratchpad base dir
//   node scripts/mine-session-data.cjs --key-file <p>      # Firebase Admin service account JSON (see below)
//   node scripts/mine-session-data.cjs --no-archive        # skip Firestore archiving even with a key file
//
// Subagent folding: this harness's Task/Agent tool doesn't write sidechain
// rows into the parent session's own .jsonl (unlike the CLI's native
// subagents/ convention the walk below already accounts for) — each spawned
// agent gets its own transcript under a per-session scratchpad tmp dir,
// /tmp/claude-<uid>/<project-slug>/<sessionId>/tasks/<agentId>.output, same
// JSONL shape as a normal transcript. mineFile() locates these per session
// and folds each agent's usage into whichever human-prompt turn was open at
// the agent's start time — matching this script's stated intent above
// ("everything the assistant did... subagent sidechains, all of it").
// CAVEAT: that scratchpad dir is ephemeral (cleared on reboot / session
// cleanup), so re-running this script after it's gone will silently produce
// a LOWER cost for the same historical row than an earlier run that still
// had it — this is a real non-reproducibility tradeoff of folding in
// ephemeral data, not a bug. Mine soon after a subagent-heavy session if you
// want that cost captured at all.
//
// Output CSV is GITIGNORED — prompts are personal data. The tracked schema
// example is data/session-training-data.example.csv.
//
// Firestore archiving (opt-in, needs a service account key — see below):
// every RAW transcript file this run reads from (each main session .jsonl,
// each folded-in subagent .output) is uploaded verbatim to Firestore under
// `session_transcripts/{fileId}` + a `chunks` subcollection (Firestore caps
// a single document at 1MiB, so content is split into ~900KB chunks — most
// transcripts are one chunk, long sessions are several). PRIVACY NOTE: this
// uploads full prompt text to the cloud — a real scope change from "stays on
// this machine" (this was an explicit, deliberate choice, not a default —
// confirmed with the project owner before implementing). "Already used"
// tracking = the parent doc's existence: if `session_transcripts/{fileId}`
// already exists, the file is skipped (no re-upload, no re-read) on future
// runs — so re-running this script is cheap and won't duplicate archives.
// Requires a Firebase Admin service account key (Firebase Console → Project
// Settings → Service Accounts → Generate new private key). Point at it via
// `--key-file <path>` or the standard `GOOGLE_APPLICATION_CREDENTIALS` env
// var. NEVER commit that key file — keep it outside the repo or rely on
// .gitignore's `*-service-account*.json` pattern. Without a resolvable key,
// archiving is silently skipped (mining/CSV output is unaffected either way).

const fs = require('fs');
const os = require('os');
const path = require('path');

const OUT_FILE = path.join(__dirname, '..', 'data', 'session-training-data.csv');
const MAX_PROMPT_CHARS = 8000; // longer = pasted dumps, not typed tasks — skip

// $/1M input tokens, $/1M output tokens — verified 2026-07-09, keep in sync
// with public/heuristic.js's MODELS table. Cache-write costs 1.25x input
// rate, cache-read 0.1x — folded into effective_in_tokens below so
// cost == effective_in * inPM + output * outPM exactly.
function pricing(modelId) {
  const m = (modelId || '').toLowerCase();
  if (m.includes('haiku')) return { inPM: 1, outPM: 5 };
  if (m.includes('fable') || m.includes('mythos')) return { inPM: 10, outPM: 50 };
  if (m.includes('opus')) return { inPM: 5, outPM: 25 };
  // ⚠️ Sonnet 5's $2/$10 is an intro rate through 2026-08-31 — $3/$15 after.
  if (m.includes('sonnet-5') || m.includes('sonnet5')) return { inPM: 2, outPM: 10 };
  return { inPM: 3, outPM: 15 }; // older sonnet + unknown
}

// Markers for non-human "user" messages injected by the harness/IDE.
const SYNTHETIC_PREFIXES = [
  '<ide_opened_file>', '<ide_selection>', '<command-name>', '<command-message>',
  '<local-command-stdout', '<system-reminder>', '<task-notes>', 'Caveat:',
  '[Request interrupted',
  // /usage-estimate's own instruction preamble (~/.claude/commands/usage-estimate.md)
  // — its `!`-substituted bash output gets inlined into the SAME message as
  // this text, with no wrapping tag, so without this exact-string check it's
  // indistinguishable from a real human prompt (see the ANSI_ESCAPE comment
  // below for the fuller incident writeup). Hand-tied to that file's exact
  // wording on purpose — update both together if it ever changes.
  "Run the current Claude Code session's actual-vs-estimated cost report",
];

// Real human-typed text never contains raw ANSI escape codes. A custom
// slash command's `!`-substituted bash output gets inlined into the SAME
// message as the command's own instruction text (one block, no
// <local-command-stdout> wrapper to catch via SYNTHETIC_PREFIXES) — so a
// command like /usage-estimate that prints a styled report ends up looking
// like a real ~100-word human prompt to the miner. Caught this directly: it
// was inflating every /usage-estimate run's own NN estimate by ~$2 against
// a real ~$0.05 turn cost, and compounding on every repeated call within a
// session (see CLAUDE.md's "/usage-estimate command (W7)" for the incident).
const ANSI_ESCAPE = /\x1b\[[0-9;]*m/;

function humanPromptText(message) {
  const content = message && message.content;
  let parts = [];
  if (typeof content === 'string') {
    parts = [content];
  } else if (Array.isArray(content)) {
    if (content.some(c => c.type === 'tool_result')) return null;
    parts = content.filter(c => c.type === 'text').map(c => c.text || '');
  } else {
    return null;
  }
  parts = parts.filter(t => {
    const s = t.trim();
    return s && !SYNTHETIC_PREFIXES.some(p => s.startsWith(p)) && !ANSI_ESCAPE.test(s);
  });
  const text = parts.join('\n').trim();
  return text || null;
}

// Applies one assistant usage block to an accumulator object (same shape
// used for both a human-prompt turn and a mined subagent file below) —
// shared so the two call sites can't drift on the cost formula. `id` dedupes
// streamed chunks of the same assistant message (identical id + usage).
function applyUsage(acc, message, id, seenMsgIds) {
  if (seenMsgIds.has(id)) return;
  seenMsgIds.add(id);
  const u = message.usage;
  const p = pricing(message.model);
  acc.model = message.model || acc.model;
  acc.apiCalls++;
  acc.inputTokens += u.input_tokens || 0;
  acc.cacheCreate += u.cache_creation_input_tokens || 0;
  acc.cacheRead += u.cache_read_input_tokens || 0;
  acc.outputTokens += u.output_tokens || 0;
  acc.cost +=
    ((u.input_tokens || 0) / 1e6) * p.inPM +
    ((u.cache_creation_input_tokens || 0) / 1e6) * p.inPM * 1.25 +
    ((u.cache_read_input_tokens || 0) / 1e6) * p.inPM * 0.1 +
    ((u.output_tokens || 0) / 1e6) * p.outPM;
}

// Mines a single subagent .output file (a plain JSONL transcript, same shape
// as a main session file, but entirely sidechain) into one usage total.
// Returns null if the file has no usage at all (e.g. a placeholder agent
// that made no API calls).
function mineSubagentFile(file) {
  const acc = { firstTimestamp: null, model: '', apiCalls: 0, inputTokens: 0, cacheCreate: 0, cacheRead: 0, outputTokens: 0, cost: 0 };
  const seenMsgIds = new Set();
  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    if (!acc.firstTimestamp && e.timestamp) acc.firstTimestamp = e.timestamp;
    if (e.type === 'assistant' && e.message && e.message.usage) {
      applyUsage(acc, e.message, e.message.id || e.uuid, seenMsgIds);
    }
  }
  return acc.apiCalls > 0 ? acc : null;
}

// Locates this session's spawned-agent transcripts, if this harness's
// scratchpad tmp dir for it still exists (see header comment — ephemeral).
// Each returned usage carries its own file path + agentId so callers can
// also archive it (see archiveTranscriptIfNeeded below), independent of
// whether it ended up folded into a turn's totals.
function findSubagentUsages(projectSlug, sessionId, subagentBase) {
  if (!subagentBase) return [];
  const tasksDir = path.join(subagentBase, projectSlug, sessionId, 'tasks');
  if (!fs.existsSync(tasksDir)) return [];
  const usages = [];
  for (const name of fs.readdirSync(tasksDir)) {
    if (!name.endsWith('.output')) continue;
    const filePath = path.join(tasksDir, name);
    const usage = mineSubagentFile(filePath);
    if (usage) usages.push({ ...usage, filePath, agentId: path.basename(name, '.output') });
  }
  return usages;
}

function mineFile(file, subagentBase) {
  const turns = [];
  let current = null;
  const seenMsgIds = new Set();

  for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let e;
    try { e = JSON.parse(line); } catch { continue; }

    if (e.type === 'user' && !e.isSidechain) {
      const text = humanPromptText(e.message);
      if (text) {
        if (current) turns.push(current);
        current = {
          text,
          timestamp: e.timestamp,
          sessionId: e.sessionId,
          cwd: e.cwd,
          model: '',
          apiCalls: 0,
          inputTokens: 0,
          cacheCreate: 0,
          cacheRead: 0,
          outputTokens: 0,
          cost: 0,
        };
      }
    } else if (e.type === 'assistant' && current && e.message && e.message.usage) {
      // Streaming writes the same assistant message across several lines with
      // identical id + usage — count each API call once.
      applyUsage(current, e.message, e.message.id || e.uuid, seenMsgIds);
    }
  }
  if (current) turns.push(current);

  // Fold in subagent usage before filtering (a turn with 0 direct API calls
  // that only delegated to an agent shouldn't happen in practice, but do
  // this before the apiCalls>0 filter below just in case).
  const sessionId = path.basename(file, '.jsonl');
  const projectSlug = path.basename(path.dirname(file));
  const subUsages = findSubagentUsages(projectSlug, sessionId, subagentBase);
  let folded = 0;
  const subagentFiles = [];
  for (const sub of subUsages) {
    subagentFiles.push({ filePath: sub.filePath, sessionId, agentId: sub.agentId, project: projectSlug });
    if (!sub.firstTimestamp) continue;
    // Attribute to the last turn whose timestamp is <= the agent's start —
    // i.e. whichever human prompt was "current" when it was spawned.
    // Timestamps are ISO strings, sortable lexicographically.
    let target = null;
    for (const t of turns) {
      if (t.timestamp && t.timestamp <= sub.firstTimestamp) target = t;
      else break;
    }
    if (!target) continue; // agent predates the first human turn in this file — skip rather than guess
    target.apiCalls += sub.apiCalls;
    target.inputTokens += sub.inputTokens;
    target.cacheCreate += sub.cacheCreate;
    target.cacheRead += sub.cacheRead;
    target.outputTokens += sub.outputTokens;
    target.cost += sub.cost;
    folded++;
  }

  return {
    turns: turns.filter(t => t.apiCalls > 0 && t.text.length <= MAX_PROMPT_CHARS),
    folded,
    subagentFiles, // archived by main() regardless of whether folding attributed them (best-effort completeness)
  };
}

function csvField(v) {
  const s = String(v).replace(/\r?\n/g, '\\n');
  return /[",\\]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
}

// Default location for this harness's per-session scratchpad tmp dirs — see
// the header comment. Only POSIX (process.getuid exists); skipped entirely
// on platforms without it (e.g. Windows) rather than guessing a path.
function defaultSubagentBase() {
  if (typeof process.getuid !== 'function') return null;
  return `/tmp/claude-${process.getuid()}`;
}

// Resolves a Firebase Admin Firestore handle from a service account key, or
// null if none is configured — archiving is always optional, never fatal.
function loadFirestoreAdmin(keyFile) {
  if (!keyFile) return null;
  if (!fs.existsSync(keyFile)) {
    console.warn(`Firestore archiving: key file not found at ${keyFile} — skipping archiving.`);
    return null;
  }
  let admin;
  try {
    admin = require('firebase-admin');
  } catch {
    console.warn('Firestore archiving: firebase-admin is not installed (run `npm install`) — skipping archiving.');
    return null;
  }
  try {
    if (!admin.apps.length) {
      admin.initializeApp({ credential: admin.credential.cert(require(path.resolve(keyFile))) });
    }
    return admin.firestore();
  } catch (err) {
    console.warn(`Firestore archiving: failed to initialize (${err.message}) — skipping archiving.`);
    return null;
  }
}

const CHUNK_BYTES = 900_000; // headroom under Firestore's 1MiB-per-doc limit
const BATCH_LIMIT = 450; // headroom under Firestore's 500-writes-per-batch limit

// Uploads one raw transcript file to Firestore verbatim, split into <1MiB
// chunks, UNLESS a doc already exists for this fileId — that's the "already
// used" check: an existing parent doc means this exact file was archived by
// a previous run, so it's skipped entirely (no read, no re-write). Returns
// 'archived' | 'skipped' | 'error' for the caller's summary counts.
async function archiveTranscriptIfNeeded(db, filePath, fileId, meta) {
  const docRef = db.collection('session_transcripts').doc(fileId);
  try {
    const existing = await docRef.get();
    if (existing.exists) return 'skipped';

    const content = fs.readFileSync(filePath, 'utf8');
    const chunks = [];
    for (let i = 0; i < content.length; i += CHUNK_BYTES) chunks.push(content.slice(i, i + CHUNK_BYTES));

    // Parent doc first (so a mid-upload crash never leaves the "already
    // used" check thinking a partially-chunked file is complete).
    await docRef.set({
      ...meta,
      byteLength: Buffer.byteLength(content, 'utf8'),
      chunkCount: chunks.length,
      archivedAt: Date.now(),
    });
    for (let i = 0; i < chunks.length; i += BATCH_LIMIT) {
      const batch = db.batch();
      chunks.slice(i, i + BATCH_LIMIT).forEach((chunk, j) => {
        batch.set(docRef.collection('chunks').doc(String(i + j)), { index: i + j, data: chunk });
      });
      await batch.commit();
    }
    return 'archived';
  } catch (err) {
    console.warn(`Firestore archiving: failed for ${filePath} (${err.message})`);
    return 'error';
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dirIdx = args.indexOf('--dir');
  const projectsDir = dirIdx !== -1 ? args[dirIdx + 1] : path.join(os.homedir(), '.claude', 'projects');

  const subagentBaseIdx = args.indexOf('--subagent-base');
  const subagentBase = args.includes('--no-subagents') ? null
    : subagentBaseIdx !== -1 ? args[subagentBaseIdx + 1]
    : defaultSubagentBase();

  const keyFileIdx = args.indexOf('--key-file');
  const keyFile = keyFileIdx !== -1 ? args[keyFileIdx + 1] : process.env.GOOGLE_APPLICATION_CREDENTIALS;
  const db = args.includes('--no-archive') ? null : loadFirestoreAdmin(keyFile);

  const files = [];
  (function walk(d) {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) {
        if (name === 'subagents') continue; // sidechain usage already appears in the parent session file
        walk(full);
      } else if (name.endsWith('.jsonl')) {
        files.push(full);
      }
    }
  })(projectsDir);

  let rows = [];
  let subagentRowsFolded = 0;
  const archiveCounts = { archived: 0, skipped: 0, error: 0 };
  for (const f of files) {
    const project = path.basename(path.dirname(f));
    const sessionId = path.basename(f, '.jsonl');
    const { turns, folded, subagentFiles } = mineFile(f, subagentBase);
    subagentRowsFolded += folded;
    for (const t of turns) rows.push({ ...t, project });

    if (db) {
      const result = await archiveTranscriptIfNeeded(db, f, sessionId, { type: 'session', project, sessionId, path: f });
      archiveCounts[result]++;
      for (const sub of subagentFiles) {
        const subResult = await archiveTranscriptIfNeeded(
          db, sub.filePath, `${sub.sessionId}__${sub.agentId}`,
          { type: 'subagent', project: sub.project, sessionId: sub.sessionId, agentId: sub.agentId, path: sub.filePath },
        );
        archiveCounts[subResult]++;
      }
    }
  }
  rows.sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));

  const header = [
    'timestamp', 'session', 'project', 'model', 'api_calls',
    'input_tokens', 'cache_creation_tokens', 'cache_read_tokens', 'output_tokens',
    'effective_in_tokens', 'total_tokens', 'out_share', 'cost_usd', 'word_count', 'task',
  ];
  const lines = [header.join(',')];
  for (const r of rows) {
    const effIn = Math.round(r.inputTokens + r.cacheCreate * 1.25 + r.cacheRead * 0.1);
    const total = effIn + r.outputTokens;
    lines.push([
      r.timestamp, r.sessionId, r.project, r.model, r.apiCalls,
      r.inputTokens, r.cacheCreate, r.cacheRead, r.outputTokens,
      effIn, total, total ? (r.outputTokens / total).toFixed(4) : '0',
      r.cost.toFixed(6), r.text.trim().split(/\s+/).length, r.text,
    ].map(csvField).join(','));
  }
  fs.writeFileSync(OUT_FILE, lines.join('\n') + '\n');

  console.log(`Mined ${rows.length} prompt→usage rows from ${files.length} session files`);
  if (subagentBase) {
    console.log(`Folded in ${subagentRowsFolded} subagent transcript(s) from ${subagentBase} (ephemeral — see header comment)`);
  } else {
    console.log('Subagent folding skipped (--no-subagents or no POSIX uid available)');
  }
  if (db) {
    console.log(`Firestore archiving: ${archiveCounts.archived} newly archived, ${archiveCounts.skipped} already present, ${archiveCounts.error} failed`);
  } else {
    console.log('Firestore archiving skipped (--no-archive, or no --key-file/GOOGLE_APPLICATION_CREDENTIALS resolved)');
  }
  console.log(`Wrote ${OUT_FILE}`);
  if (args.includes('--stats') && rows.length) {
    const totals = rows.map(r => Math.round(r.inputTokens + r.cacheCreate * 1.25 + r.cacheRead * 0.1) + r.outputTokens).sort((a, b) => a - b);
    const q = p => totals[Math.floor(p * (totals.length - 1))];
    const cost = rows.reduce((s, r) => s + r.cost, 0);
    console.log(`  total cost represented: $${cost.toFixed(2)}`);
    console.log(`  effective tokens/turn — p10: ${q(0.1)}  median: ${q(0.5)}  p90: ${q(0.9)}  max: ${q(1)}`);
  }
}

if (require.main === module) {
  main().catch(err => {
    console.error(err);
    process.exit(1);
  });
}

module.exports = { archiveTranscriptIfNeeded, mineFile, mineSubagentFile, CHUNK_BYTES, BATCH_LIMIT };
