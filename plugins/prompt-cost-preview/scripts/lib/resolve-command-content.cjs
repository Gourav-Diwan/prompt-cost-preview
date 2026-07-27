// Resolves a slash command's actual instruction content from its
// command_name, for command-cost-estimate.cjs (UserPromptExpansion) to
// estimate cost against. The UserPromptExpansion hook payload carries only
// command_name/command_args/command_source/the raw typed text — NEVER the
// expanded instruction text itself (confirmed empirically, via a temporary
// debug hook capturing a real payload — this event has no full I/O schema
// in the public hooks reference beyond a one-line summary-table mention).
// So this module has to locate and read the command's own source file.
//
// command_source's possible string values aren't confirmed beyond
// "plugin" (the only one seen in a real captured payload), so this tries
// several candidate paths in a fixed order rather than switching on
// command_source — safer given the enum itself is unconfirmed.
//
// Every fs call is guarded; this module must NEVER throw. Returns null on
// any failure, which the caller treats as "can't estimate this command,
// pass through ungated" — same fail-open contract as every other estimate
// path in this plugin.

const fs = require('fs');
const path = require('path');
const os = require('os');

// Path segments come from a hook payload whose trust boundary isn't
// established the way UserPromptSubmit's freeform prompt text is — reject
// anything that could escape the intended directory before it ever touches
// path.join.
function isSafeSegment(seg) {
  return typeof seg === 'string' && seg.length > 0 && !seg.includes('..') && !seg.includes('/') && !seg.includes('\\');
}

function readFileSafe(absPath) {
  try {
    if (!fs.existsSync(absPath) || !fs.statSync(absPath).isFile()) return null;
    const text = fs.readFileSync(absPath, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

function listDirsByMtimeDesc(dir) {
  try {
    return fs.readdirSync(dir)
      .map((name) => ({ name, full: path.join(dir, name) }))
      .filter((d) => {
        try { return fs.statSync(d.full).isDirectory(); } catch { return false; }
      })
      .sort((a, b) => {
        try { return fs.statSync(b.full).mtimeMs - fs.statSync(a.full).mtimeMs; } catch { return 0; }
      });
  } catch {
    return [];
  }
}

// Plugin form: command_name = "pluginName:skillName". The first path
// segment under ~/.claude/plugins/cache/ is the MARKETPLACE dir name, not
// the plugin name — they only coincide when a plugin's marketplace repo
// happens to share its name (confirmed by reading the real cache layout on
// this machine) — so every marketplace dir has to be tried, not assumed.
function resolvePluginCommandContent(pluginName, skillName) {
  if (!isSafeSegment(pluginName) || !isSafeSegment(skillName)) return null;
  const cacheRoot = path.join(os.homedir(), '.claude', 'plugins', 'cache');
  for (const marketplace of listDirsByMtimeDesc(cacheRoot)) {
    const pluginDir = path.join(marketplace.full, pluginName);
    if (!fs.existsSync(pluginDir)) continue;
    for (const version of listDirsByMtimeDesc(pluginDir)) {
      const skillHit = readFileSafe(path.join(version.full, 'skills', skillName, 'SKILL.md'));
      if (skillHit) return skillHit;
      const commandHit = readFileSafe(path.join(version.full, 'commands', `${skillName}.md`));
      if (commandHit) return commandHit;
    }
  }
  return null;
}

// Project- and user-scoped candidates, for a bare (non-plugin) command
// name, or as a fallback if the plugin-form lookup above misses.
function resolveLocalCommandContent(name, cwd) {
  if (!isSafeSegment(name)) return null;
  const candidates = [];
  if (typeof cwd === 'string' && cwd) {
    candidates.push(path.join(cwd, '.claude', 'skills', name, 'SKILL.md'));
    candidates.push(path.join(cwd, '.claude', 'commands', `${name}.md`));
  }
  candidates.push(path.join(os.homedir(), '.claude', 'skills', name, 'SKILL.md'));
  candidates.push(path.join(os.homedir(), '.claude', 'commands', `${name}.md`));
  for (const candidate of candidates) {
    const hit = readFileSafe(candidate);
    if (hit) return hit;
  }
  return null;
}

// resolveCommandContent({ command_name, cwd }) -> string | null
function resolveCommandContent({ command_name, cwd }) {
  try {
    if (typeof command_name !== 'string' || !command_name.trim()) return null;
    const colonIdx = command_name.indexOf(':');

    if (colonIdx > 0) {
      const pluginName = command_name.slice(0, colonIdx);
      const skillName = command_name.slice(colonIdx + 1);
      const pluginHit = resolvePluginCommandContent(pluginName, skillName);
      if (pluginHit) return pluginHit;
      // Defensive fallback in case command_source has a prefixed form this
      // design didn't anticipate — try local resolution on both the full
      // name and the bare skill name.
      return resolveLocalCommandContent(command_name, cwd) || resolveLocalCommandContent(skillName, cwd);
    }

    return resolveLocalCommandContent(command_name, cwd);
  } catch {
    return null;
  }
}

module.exports = { resolveCommandContent };
