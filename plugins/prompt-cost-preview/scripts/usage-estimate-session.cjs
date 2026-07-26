#!/usr/bin/env node
// Prints actual cost (mined from the current Claude Code session's own
// transcript, same math as mine-session-data.cjs) side by side with what
// the bundled estimator (lib/heuristic.js / lib/token-model-core.js, loaded
// via lib/load-globals.cjs) would have predicted for the same turns.
//
// Output is styled after Claude Code's own built-in /usage panel (header,
// "This session" summary, per-model "Breakdown" blocks), with an added
// "Estimated cost" row per model — hence "Usage-Estimate", not "Usage".
// The 5-hour/weekly rate-limit bars /usage shows are NOT reproduced here:
// that data is computed only inside /usage's own interactive render — no
// CLI flag, local cache, or API exposes it to an external script — so a
// placeholder note stands in for that section.
//
// This is the portable plugin fork: unlike the private-repo original this
// was forked from, it never writes anywhere on disk except an explicit
// --html <path> the caller provides — no training-data CSV logging, since
// there's no shared dataset for a plugin installed on someone else's
// machine to log into.
//
// Usage: node usage-estimate-session.cjs [--cwd <path>]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { mineFile } = require('./mine-session-data.cjs');
const loadGlobals = require('./lib/load-globals.cjs');

// Same POSIX-only scratchpad convention mine-session-data.cjs uses for
// folding in this harness's spawned-subagent transcripts.
function defaultSubagentBase() {
  if (typeof process.getuid !== 'function') return null;
  return `/tmp/claude-${process.getuid()}`;
}

// Claude Code's own project-directory naming convention: cwd with BOTH '/'
// and '.' replaced by '-' (not just '/' — a worktree path like
// .../.claude/worktrees/<name> has a literal dot that must convert too, or
// the slug diverges from the real directory name).
function projectSlugFor(cwd) {
  return cwd.replace(/[/.]/g, '-');
}

// Finds the most-recently-modified *.jsonl directly under the project's
// transcript dir (excluding the subagents/ subdir — sidechain usage already
// appears in the parent session file, same as mine-session-data.cjs) — a
// heuristic for "the current session," since Claude Code doesn't expose the
// active session id to an invoked shell command directly.
function findCurrentSessionFile(cwd) {
  const projectsDir = path.join(os.homedir(), '.claude', 'projects');
  const slug = projectSlugFor(cwd);
  const dir = path.join(projectsDir, slug);
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

// heuristic.js model keys, matched the same way mine-session-data.cjs's
// pricing() matches its own {inPM,outPM} table — same substrings, different
// target shape, so kept as its own small function rather than sharing one.
function toModelKey(rawModel) {
  const m = (rawModel || '').toLowerCase();
  if (m.includes('haiku')) return 'haiku';
  if (m.includes('fable') || m.includes('mythos')) return 'fable';
  if (m.includes('opus')) return 'opus';
  if (m.includes('sonnet')) return 'sonnet';
  return 'sonnet'; // unknown Anthropic model id — closest default
}

// ─── Formatting helpers ─────────────────────────────────────────────────────

// Colors only make sense on a real terminal — this is usually invoked
// through a Skill, whose output is captured (not attached to a TTY), so raw
// ANSI codes would print as literal "[1m...[0m" garbage instead of being
// interpreted. Degrade to plain text there; only color when stdout.isTTY is
// actually true.
const useColor = !!process.stdout.isTTY;
const ansi = { reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m', red: '\x1b[31m', amber: '\x1b[33m', green: '\x1b[32m' };
const bold = s => useColor ? `${ansi.bold}${s}${ansi.reset}` : s;
const dim = s => useColor ? `${ansi.dim}${s}${ansi.reset}` : s;

// Column layout matching the built-in /usage panel's card width — label(s)
// left-aligned, value(s) right-aligned within a fixed total line width.
// Padding is computed on the VISIBLE length (ANSI codes stripped) so bold/
// dim/color codes don't throw off alignment.
const LINE_WIDTH = 64;
const stripAnsi = s => s.replace(/\x1b\[[0-9;]*m/g, '');
const vlen = s => stripAnsi(s).length;

function twoCol(label, value) {
  const gap = Math.max(1, LINE_WIDTH - vlen(label) - vlen(value));
  return label + ' '.repeat(gap) + value;
}

function threeCol(a, b, c) {
  const colWidth = Math.floor(LINE_WIDTH / 3);
  const pad = (s, w) => s + ' '.repeat(Math.max(1, w - vlen(s)));
  return pad(a, colWidth) + pad(b, colWidth) + c;
}

function fmt(n) {
  return `$${n.toFixed(4)}`;
}

// 15600 -> "15.6k", 11886600 -> "11.9M", small numbers print as-is — matches
// /usage's own style.
function formatCompact(n) {
  if (!n) return '0';
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(Math.round(n));
}

// last-turn-timestamp minus first-turn-timestamp — a real, derivable number
// (unlike /usage's "API" in-flight time, which has no equivalent in mined
// token-usage data and is deliberately not shown here).
function formatDuration(ms) {
  if (!ms || ms < 0) return '0s';
  const totalSec = Math.round(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function capitalize(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function accuracyColor(pct) {
  const label = `${pct.toFixed(0)}%`;
  if (!useColor) return label;
  const color = pct > 150 ? ansi.red : pct < 70 ? ansi.amber : ansi.green;
  return `${color}${label}${ansi.reset}`;
}

// "12h 5m" / "45m" / "38s" — a friendlier long-form than formatDuration()'s
// "m s" style, used in the HTML report card rather than the console table.
function formatDurationLong(ms) {
  if (!ms || ms < 0) return '0m';
  const totalMin = Math.floor(ms / 60000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m`;
  return `${Math.round(ms / 1000)}s`;
}

// Same three tiers accuracyColor() already uses (>150% red / <70% amber /
// else green), plus the human-readable direction so the HTML report can
// explain WHY, not just show a number.
function accuracyTier(pct) {
  if (pct > 150) return { tier: 'bad', message: 'Underestimated — actual cost exceeded the estimate' };
  if (pct < 70) return { tier: 'warn', message: 'Overestimated — long, cache-heavy turns cost less than their word count implies' };
  return { tier: 'good', message: 'Within a reasonable range of the estimate' };
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Renders the full standalone report page. Self-contained (inline CSS, no
// external fonts/requests) so it's safe to publish as-is via the Artifact
// tool.
function renderHtml(data) {
  const { sessionId, turnCount, activeMs, totalActual, totalEstimate, cacheHitPct, models } = data;
  const maxVal = Math.max(totalActual, totalEstimate) || 1;
  const estimateWidthPct = (totalEstimate / maxVal) * 100;
  const actualWidthPct = (totalActual / maxVal) * 100;
  const accPct = totalEstimate > 0 ? (totalActual / totalEstimate) * 100 : 0;
  const acc = accuracyTier(accPct);
  const modelSummary = models.map(m => `${escapeHtml(m.label)} · ${Math.round((m.turnCount / turnCount) * 100)}%`).join(', ');

  // One table, models as columns sharing the same row labels — a single
  // model still renders fine as a 2-column table (label + one value column),
  // so there's no separate single-vs-multi code path to keep in sync.
  const BREAKDOWN_ROWS = [
    { label: 'Input', key: 'inputTokens', fmt: formatCompact },
    { label: 'Output', key: 'outputTokens', fmt: formatCompact },
    { label: 'Cache read', key: 'cacheRead', fmt: formatCompact },
    { label: 'Cache write', key: 'cacheCreate', fmt: formatCompact },
    { label: 'Estimated cost', key: 'estimateCost', fmt, emphasis: true },
  ];
  const bdGridCols = `minmax(88px, 1fr) repeat(${models.length}, minmax(72px, 1fr))`;
  const bdHeaderCells = models.map(m => {
    const pct = totalActual > 0 ? Math.round((m.actualCost / totalActual) * 100) : Math.round((m.turnCount / turnCount) * 100);
    return `<div class="bd-cell bd-head">${escapeHtml(m.label)} <span class="bd-pct">${pct}%</span></div>`;
  }).join('');
  const bdRows = BREAKDOWN_ROWS.map(row => `
    <div class="bd-cell bd-rowlabel${row.emphasis ? ' emphasis' : ''}">${row.label}</div>${models.map(m =>
      `<div class="bd-cell bd-value num${row.emphasis ? ' emphasis' : ''}">${row.fmt(m[row.key])}</div>`).join('')}`).join('');
  const breakdownTable = `
  <hr class="divider" />
  <h2>Breakdown</h2>
  <div class="bd-scroll">
    <div class="bd-grid" style="grid-template-columns: ${bdGridCols};">
      <div class="bd-cell bd-corner"></div>${bdHeaderCells}${bdRows}
    </div>
  </div>`;

  return `<title>Usage · Estimate</title>
<style>
  :root {
    --bg-page: #eef0f2; --bg-card: #ffffff; --border: rgba(15,15,17,0.09); --border-strong: rgba(15,15,17,0.14);
    --text-primary: #1a1a1d; --text-secondary: #6b6b70; --text-tertiary: #9a9aa0;
    --accent-good: #1c8a4b; --accent-good-bg: rgba(28,138,75,0.12);
    --accent-warn: #b25a00; --accent-warn-bg: rgba(178,90,0,0.12);
    --accent-bad: #c22e2e; --accent-bad-bg: rgba(194,46,46,0.12);
    --bar-track: rgba(15,15,17,0.08);
    --shadow: 0 1px 2px rgba(15,15,17,0.04), 0 12px 32px -16px rgba(15,15,17,0.18);
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --bg-page: #0a0a0b; --bg-card: #1c1c1e; --border: rgba(255,255,255,0.08); --border-strong: rgba(255,255,255,0.14);
      --text-primary: #f5f5f7; --text-secondary: #8e8e93; --text-tertiary: #6a6a6e;
      --accent-good: #34c759; --accent-good-bg: rgba(52,199,89,0.16);
      --accent-warn: #ff9f0a; --accent-warn-bg: rgba(255,159,10,0.16);
      --accent-bad: #ff453a; --accent-bad-bg: rgba(255,69,58,0.16);
      --bar-track: rgba(255,255,255,0.09);
      --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 20px 48px -20px rgba(0,0,0,0.6);
    }
  }
  :root[data-theme="dark"] {
    --bg-page: #0a0a0b; --bg-card: #1c1c1e; --border: rgba(255,255,255,0.08); --border-strong: rgba(255,255,255,0.14);
    --text-primary: #f5f5f7; --text-secondary: #8e8e93; --text-tertiary: #6a6a6e;
    --accent-good: #34c759; --accent-good-bg: rgba(52,199,89,0.16);
    --accent-warn: #ff9f0a; --accent-warn-bg: rgba(255,159,10,0.16);
    --accent-bad: #ff453a; --accent-bad-bg: rgba(255,69,58,0.16);
    --bar-track: rgba(255,255,255,0.09);
    --shadow: 0 1px 2px rgba(0,0,0,0.3), 0 20px 48px -20px rgba(0,0,0,0.6);
  }
  :root[data-theme="light"] {
    --bg-page: #eef0f2; --bg-card: #ffffff; --border: rgba(15,15,17,0.09); --border-strong: rgba(15,15,17,0.14);
    --text-primary: #1a1a1d; --text-secondary: #6b6b70; --text-tertiary: #9a9aa0;
    --accent-good: #1c8a4b; --accent-good-bg: rgba(28,138,75,0.12);
    --accent-warn: #b25a00; --accent-warn-bg: rgba(178,90,0,0.12);
    --accent-bad: #c22e2e; --accent-bad-bg: rgba(194,46,46,0.12);
    --bar-track: rgba(15,15,17,0.08);
    --shadow: 0 1px 2px rgba(15,15,17,0.04), 0 12px 32px -16px rgba(15,15,17,0.18);
  }
  * { box-sizing: border-box; }
  body {
    margin: 0; min-height: 100vh; display: flex; align-items: flex-start; justify-content: center;
    padding: 48px 20px; background: var(--bg-page);
    font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Segoe UI", system-ui, sans-serif;
    color: var(--text-primary); -webkit-font-smoothing: antialiased;
  }
  .num { font-family: ui-monospace, "SF Mono", "Cascadia Code", Menlo, Consolas, monospace; font-variant-numeric: tabular-nums; letter-spacing: -0.01em; }
  .card { width: 100%; max-width: 460px; background: var(--bg-card); border: 1px solid var(--border); border-radius: 18px; box-shadow: var(--shadow); padding: 28px 26px 24px; }
  .eyebrow { font-size: 11px; font-weight: 600; letter-spacing: 0.08em; text-transform: uppercase; color: var(--text-tertiary); margin: 0 0 4px; }
  h1 { font-size: 22px; font-weight: 650; letter-spacing: -0.015em; margin: 0; text-wrap: balance; }
  .session-meta { margin: 6px 0 0; font-size: 13px; color: var(--text-secondary); }
  .session-meta .num { color: var(--text-tertiary); }
  .note { margin: 10px 0 0; font-size: 12px; line-height: 1.5; color: var(--text-tertiary); }
  .divider { border: none; border-top: 1px solid var(--border); margin: 20px 0; }
  h2 { font-size: 13px; font-weight: 650; margin: 0 0 12px; color: var(--text-primary); }
  .stat-row { display: grid; grid-template-columns: repeat(2, 1fr); gap: 14px 8px; }
  .stat { display: flex; flex-direction: column; gap: 3px; }
  .stat-label { font-size: 12px; color: var(--text-secondary); }
  .stat-value { font-size: 17px; font-weight: 600; }
  .stat-value .unit { font-size: 12px; font-weight: 500; color: var(--text-tertiary); margin-left: 2px; }
  .bd-scroll { overflow-x: auto; margin: 0 -2px; }
  .bd-grid { display: grid; align-items: baseline; column-gap: 14px; min-width: 100%; }
  .bd-cell { padding: 7px 2px; font-size: 13.5px; white-space: nowrap; }
  .bd-corner, .bd-head {
    padding-top: 0; padding-bottom: 8px; border-bottom: 1px solid var(--border-strong);
    font-size: 11.5px; font-weight: 650; color: var(--text-tertiary);
    text-transform: uppercase; letter-spacing: 0.04em;
  }
  .bd-head { text-align: right; }
  .bd-pct { font-weight: 500; opacity: 0.8; }
  .bd-rowlabel { color: var(--text-secondary); border-top: 1px solid var(--border); }
  .bd-value { color: var(--text-primary); font-weight: 500; text-align: right; border-top: 1px solid var(--border); }
  .bd-rowlabel.emphasis, .bd-value.emphasis { color: var(--text-primary); font-weight: 650; }
  .compare { display: flex; flex-direction: column; gap: 10px; }
  .compare-row { display: grid; grid-template-columns: 74px 1fr 64px; align-items: center; gap: 10px; }
  .compare-label { font-size: 12.5px; color: var(--text-secondary); }
  .compare-value { font-size: 13px; text-align: right; font-weight: 600; }
  .bar-track { height: 8px; border-radius: 5px; background: var(--bar-track); overflow: hidden; }
  .bar-fill { height: 100%; border-radius: 5px; }
  .bar-fill.estimate { background: var(--text-tertiary); }
  .bar-fill.actual { background: var(--accent-${acc.tier}); }
  .accuracy-chip { margin-top: 14px; display: flex; align-items: center; justify-content: space-between; padding: 12px 14px; border-radius: 12px; background: var(--accent-${acc.tier}-bg); }
  .accuracy-chip .label { font-size: 12.5px; color: var(--text-secondary); }
  .accuracy-chip .pct { font-size: 19px; font-weight: 700; color: var(--accent-${acc.tier}); }
  .accuracy-chip .sub { font-size: 11.5px; color: var(--text-tertiary); margin-top: 2px; }
  .footer { margin-top: 20px; padding-top: 14px; border-top: 1px solid var(--border); font-size: 11px; color: var(--text-tertiary); line-height: 1.6; }
</style>

<div class="card">
  <p class="eyebrow">Claude Code · Local report</p>
  <h1>Usage · Estimate</h1>
  <p class="session-meta">Session <span class="num">${escapeHtml(sessionId.slice(0, 8))}</span> · ${turnCount} turn${turnCount === 1 ? '' : 's'} · active <span class="num">${formatDurationLong(activeMs)}</span> · ${escapeHtml(modelSummary)}</p>
  <p class="note">5-hour / weekly limit bars aren't available outside <code class="num">/usage</code>'s own native render — this report covers what the estimator can see: actual cost mined from the transcript, next to what it would have predicted.</p>

  <hr class="divider" />

  <h2>This session</h2>
  <div class="stat-row">
    <div class="stat">
      <span class="stat-label">Actual cost</span>
      <span class="stat-value num">${fmt(totalActual)}</span>
    </div>
    <div class="stat">
      <span class="stat-label">Cache hit</span>
      <span class="stat-value num">${cacheHitPct !== null ? Math.round(cacheHitPct) : '—'}<span class="unit">%</span></span>
    </div>
  </div>
${breakdownTable}

  <hr class="divider" />

  <h2>Estimate vs. actual</h2>
  <div class="compare">
    <div class="compare-row">
      <span class="compare-label">Estimated</span>
      <div class="bar-track"><div class="bar-fill estimate" style="width: ${estimateWidthPct.toFixed(1)}%;"></div></div>
      <span class="compare-value num">${fmt(totalEstimate)}</span>
    </div>
    <div class="compare-row">
      <span class="compare-label">Actual</span>
      <div class="bar-track"><div class="bar-fill actual" style="width: ${actualWidthPct.toFixed(1)}%;"></div></div>
      <span class="compare-value num">${fmt(totalActual)}</span>
    </div>
  </div>
  <div class="accuracy-chip">
    <div>
      <div class="label">Accuracy (actual ÷ estimated)</div>
      <div class="sub">${escapeHtml(acc.message)}</div>
    </div>
    <div class="pct num">${accPct.toFixed(0)}%</div>
  </div>

  <div class="footer">
    Generated ${escapeHtml(new Date().toLocaleString())} from <code class="num">usage-estimate-session.cjs --html</code> · snapshot, not live — ask for a refresh to pull current numbers.
  </div>
</div>
`;
}

function main() {
  const args = process.argv.slice(2);
  const cwdIdx = args.indexOf('--cwd');
  const cwd = cwdIdx !== -1 ? path.resolve(args[cwdIdx + 1]) : process.cwd();

  const sessionFile = findCurrentSessionFile(cwd);
  if (!sessionFile) {
    console.log(`No Claude Code session transcript found for ${cwd} — nothing to report.`);
    return;
  }

  const subagentBase = defaultSubagentBase();
  const { turns } = mineFile(sessionFile, subagentBase);
  if (!turns.length) {
    console.log(`Found ${sessionFile} but it has no usage yet — nothing to report.`);
    return;
  }

  const g = loadGlobals({ withWeights: true });

  // Per-model aggregation, keyed by heuristic model key so same-family
  // model variants group together the way /usage groups by family.
  const byModel = {};
  let totalActual = 0;
  let totalEstimate = 0;
  let totalCacheRead = 0;
  let totalCacheCreate = 0;

  // Session-position features for the estimator — same definition the
  // trainer derives from the mined data (turnIndex = 0-based position,
  // priorTokens = cumulative effective total tokens of all earlier turns),
  // so training-time and inference-time features can't disagree.
  let turnIndex = 0;
  let priorTokens = 0;

  // Sum-of-medians correction for aggregating a whole session — measured by
  // the trainer on real sessions, stored in the weights (1 when no trained
  // weights / too few sessions). See lib/token-model-core.js's
  // sessionSumCalibration() for why this applies here but not to single-task
  // estimates.
  const sumCalibration = g.sessionSumCalibration();

  for (const t of turns) {
    const modelKey = toModelKey(t.model);
    if (!byModel[modelKey]) {
      byModel[modelKey] = {
        // MODELS in heuristic.js is a top-level `const` — vm.runInContext
        // only attaches function declarations to the context object, not
        // const/let bindings (that's why g.estimateTask works but a direct
        // g.MODELS lookup wouldn't) — so the capitalized key stands in as
        // the display label instead, matching the screenshot's short style.
        label: capitalize(modelKey),
        inputTokens: 0, outputTokens: 0, cacheRead: 0, cacheCreate: 0,
        actualCost: 0, estimateCost: 0, turnCount: 0,
      };
    }
    const b = byModel[modelKey];
    b.inputTokens += t.inputTokens;
    b.outputTokens += t.outputTokens;
    b.cacheRead += t.cacheRead;
    b.cacheCreate += t.cacheCreate;
    b.actualCost += t.cost;
    b.turnCount++;

    // agentic: true is required — Claude Code turns cost ~100x a chat-mode
    // estimate for the same text.
    const est = g.estimateTask(t.text, modelKey, { agentic: true, turnIndex, priorTokens });
    // GEOMETRIC mean of the range, not arithmetic: the NN's bounds are
    // mid·e^∓σ, so (low+high)/2 = mid·cosh(σ) — a silent inflation the
    // geometric mean avoids. The calibration then corrects the
    // median→sum skew (see above).
    const estCost = Math.sqrt(est.costLow * est.costHigh) * sumCalibration;
    b.estimateCost += estCost;

    totalActual += t.cost;
    totalEstimate += estCost;
    totalCacheRead += t.cacheRead;
    totalCacheCreate += t.cacheCreate;

    // Same total_tokens definition as the miner's row shape: effective
    // input (cache-weighted) + output.
    turnIndex++;
    priorTokens += Math.round(t.inputTokens + t.cacheCreate * 1.25 + t.cacheRead * 0.1) + t.outputTokens;
  }

  const sortedModels = Object.entries(byModel).sort((a, b) => b[1].actualCost - a[1].actualCost);
  const activeMs = new Date(turns[turns.length - 1].timestamp) - new Date(turns[0].timestamp);
  const cacheDenom = totalCacheRead + totalCacheCreate;
  const cacheHitPct = cacheDenom > 0 ? (totalCacheRead / cacheDenom) * 100 : null;

  // Shared data shape for both --json and --html — one source of truth so
  // the two never drift apart.
  const reportData = {
    sessionId: path.basename(sessionFile, '.jsonl'),
    turnCount: turns.length,
    activeMs,
    totalActual,
    totalEstimate,
    cacheHitPct,
    models: sortedModels.map(([key, b]) => ({
      key, label: b.label,
      inputTokens: b.inputTokens, outputTokens: b.outputTokens,
      cacheRead: b.cacheRead, cacheCreate: b.cacheCreate,
      actualCost: b.actualCost, estimateCost: b.estimateCost,
      turnCount: b.turnCount,
    })),
  };

  // --json: structured output for tooling instead of the plain-text console
  // report below.
  if (args.includes('--json')) {
    console.log(JSON.stringify(reportData, null, 2));
    return;
  }

  // --html <path>: writes the styled report card to disk — the caller (the
  // usage-estimate skill's instructions) then publishes this file via the
  // Artifact tool, always as a FRESH artifact (no CSV logging, no
  // hardcoded URL to update in place — see the skill's own instructions).
  const htmlIdx = args.indexOf('--html');
  if (htmlIdx !== -1) {
    const outPath = path.resolve(args[htmlIdx + 1]);
    fs.writeFileSync(outPath, renderHtml(reportData));
    console.log(`Wrote ${outPath}`);
    return;
  }

  // ─── Header — mirrors /usage's card: title, then a "This session" block
  // of label/value columns, then one "Breakdown" block per model. The
  // 5-hour/weekly limit bars and "What's using your limits?" section from
  // /usage's own panel are NOT reproduced — that data is computed only
  // inside /usage's own interactive render, with no CLI flag, cache, or API
  // exposing it to an external script.
  console.log(`\n${bold('Usage-Estimate')}`);
  console.log(dim(`Session ${path.basename(sessionFile, '.jsonl')} — ${turns.length} turn${turns.length === 1 ? '' : 's'}`));
  console.log(dim('(5-hour / weekly limit bars aren\'t available outside /usage\'s own render)'));

  // ─── This session ─────────────────────────────────────────────────────
  console.log(`\n${bold('This session')}`);
  console.log(threeCol(
    `Cost ${dim(fmt(totalActual))}`,
    `Active ${dim(formatDuration(activeMs))}`,
    '',
  ));
  const modelPctCols = sortedModels.map(([, b]) => {
    const pct = totalActual > 0 ? Math.round((b.actualCost / totalActual) * 100) : Math.round((b.turnCount / turns.length) * 100);
    return `${b.label} ${dim(pct + '%')}`;
  });
  console.log(threeCol(
    modelPctCols[0] || '',
    modelPctCols[1] || '',
    cacheHitPct !== null ? `Cache hit ${dim(Math.round(cacheHitPct) + '%')}` : '',
  ));

  // ─── Breakdown, one block per model — right-aligned values, same as
  // /usage's own card. "Estimated cost" is the row this tool adds beyond
  // what /usage itself shows.
  for (const [, b] of sortedModels) {
    console.log(`\n${twoCol(bold('Breakdown'), dim(b.label))}`);
    console.log(twoCol('Input', formatCompact(b.inputTokens)));
    console.log(twoCol('Output', formatCompact(b.outputTokens)));
    console.log(twoCol('Cache read', formatCompact(b.cacheRead)));
    console.log(twoCol('Cache write', formatCompact(b.cacheCreate)));
    console.log(twoCol('Estimated cost', fmt(b.estimateCost)));
  }

  // ─── Estimate vs. actual (this tool's whole point — not part of /usage) ─
  console.log(`\n${bold('Estimate vs. actual')}`);
  console.log(twoCol('Estimated (agentic mode)', fmt(totalEstimate)));
  console.log(twoCol('Actual', fmt(totalActual)));
  if (totalEstimate > 0) {
    const pct = (totalActual / totalEstimate) * 100;
    console.log(twoCol('Accuracy (actual / estimated)', accuracyColor(pct)));
  }
}

main();
