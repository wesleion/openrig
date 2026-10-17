import path from "node:path";
import { createHash } from "node:crypto";
import { shellQuote } from "./shell-quote.js";
import type { ClaudeAdapterFsOps } from "./claude-code-adapter.js";

export interface ClaudeCompactionProjectionResult {
  changed: boolean;
  delivered: boolean;
  skillPath: string;
  fallbackSkillPath: string;
  warnings: string[];
}

interface OwnershipManifest {
  version: 1;
  files: Record<string, { sha256: string }>;
}

const digest = (content: string) => createHash("sha256").update(content).digest("hex");
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const SKILL = "skills/claude-compaction-restore";
const BRIDGE = "hooks/scripts/compaction-restore-bridge.cjs";
const PRECOMPACT = `${SKILL}/scripts/precompact-hook.mjs`;

export function isCanonicalClaudeCompactionPlugin(fs: ClaudeAdapterFsOps, pluginPath: string): boolean {
  try {
    const manifest = JSON.parse(fs.readFile(path.join(pluginPath, ".claude-plugin", "plugin.json")));
    return object(manifest) && manifest["name"] === "openrig-core";
  } catch { return false; }
}

function ownedCommand(value: unknown): boolean {
  if (typeof value !== "string" || /[\r\n]/.test(value)) return false;
  const match = /^node ('.*')$/.exec(value);
  if (!match) return false;
  const decoded = match[1]!.slice(1, -1).replace(/'"'"'/g, "'");
  if (shellQuote(decoded) !== match[1]) return false;
  return decoded.endsWith("/.openrig/hooks/scripts/compaction-restore-bridge.cjs")
    || decoded.endsWith("/.claude/skills/claude-compaction-restore/scripts/precompact-hook.mjs");
}

/** Reconcile selected canonical assets only. Absence in another seat sharing cwd
 * is not authority to remove this workspace's hooks or assets. */
export function reconcileClaudeCompactionProjection(input: {
  fs: ClaudeAdapterFsOps;
  cwd: string;
  pluginPath: string;
  recordProjection?: (targetPath: string, content: string) => void;
}): ClaudeCompactionProjectionResult {
  const { fs, cwd, pluginPath } = input;
  const skillPath = path.join(cwd, ".claude", "skills", "claude-compaction-restore", "SKILL.md");
  const fallbackSkillPath = path.join(pluginPath, SKILL, "SKILL.md");
  const result: ClaudeCompactionProjectionResult = { changed: false, delivered: false, skillPath, fallbackSkillPath, warnings: [] };
  const fail = (message: string) => {
    result.warnings.push(`Claude compaction projection: ${message}. Read the original skill directly at ${JSON.stringify(fallbackSkillPath)}; existing files and hooks were preserved.`);
    return result;
  };
  const settingsPath = path.join(cwd, ".claude", "settings.local.json");
  const ownershipPath = path.join(cwd, ".openrig", "hooks", "compaction-assets.json");
  const safeTarget = (target: string) => {
    if (!fs.inspectPath) return false;
    const relative = path.relative(cwd, target);
    if (path.isAbsolute(relative) || relative.split(path.sep).includes("..")) return false;
    let current = cwd;
    const components = relative.split(path.sep);
    for (let i = 0; i < components.length; i++) {
      current = path.join(current, components[i]!);
      const kind = fs.inspectPath(current);
      if (kind === "symlink" || kind === "other" || (i < components.length - 1 && kind === "file")
        || (i === components.length - 1 && kind === "directory")) return false;
    }
    return true;
  };
  let settings: Record<string, unknown>;
  let ownership: OwnershipManifest = { version: 1, files: {} };
  let ownershipBefore: string | null = null;
  let sourceHooks: Record<string, unknown>;
  try {
    if (!safeTarget(settingsPath) || !safeTarget(ownershipPath)) return fail("unsafe target path or missing symlink inspection");
    settings = fs.exists(settingsPath) ? JSON.parse(fs.readFile(settingsPath)) : {};
    if (!object(settings) || (settings["hooks"] !== undefined && !object(settings["hooks"]))) return fail("malformed settings.local.json");
    if (fs.exists(ownershipPath)) {
      ownershipBefore = fs.readFile(ownershipPath);
      const existing: unknown = JSON.parse(ownershipBefore);
      if (!object(existing) || existing["version"] !== 1 || !object(existing["files"])) return fail("malformed ownership manifest");
      ownership = existing as unknown as OwnershipManifest;
    }
    const hooksManifest: unknown = JSON.parse(fs.readFile(path.join(pluginPath, "hooks", "claude.json")));
    if (!object(hooksManifest) || !object(hooksManifest["hooks"])) return fail("canonical hook manifest unavailable");
    sourceHooks = hooksManifest["hooks"];
  } catch { return fail("unreadable or malformed source/settings/ownership manifest"); }

  const desired: Array<{ event: string; group: Record<string, unknown> }> = [];
  const selected: Record<string, string> = {
    SessionStart: BRIDGE, UserPromptSubmit: BRIDGE, PreCompact: PRECOMPACT, PostCompact: BRIDGE,
  };
  for (const [event, script] of Object.entries(selected)) {
    const groups = sourceHooks[event];
    if (!Array.isArray(groups)) return fail(`missing canonical ${event} hook`);
    let match: Record<string, unknown> | undefined;
    for (const group of groups) {
      if (!object(group) || !Array.isArray(group["hooks"])) continue;
      if (event === "SessionStart" && group["matcher"] !== "compact") continue;
      const hook = group["hooks"].find((entry: unknown) => object(entry)
        && entry["type"] === "command"
        && entry["command"] === `node "\${CLAUDE_PLUGIN_ROOT}/${script}"`);
      if (!object(hook)) continue;
      const target = script === BRIDGE ? path.join(cwd, ".openrig", BRIDGE) : path.join(cwd, ".claude", PRECOMPACT);
      const managedHook = { ...hook, command: `node ${shellQuote(target)}` };
      match = { ...group, hooks: [managedHook] };
      break;
    }
    if (!match) return fail(`missing exact canonical ${event} command`);
    desired.push({ event, group: match });
  }

  const assets: Array<{ source: string; relative: string; content: string }> = [];
  try {
    if (!fs.listFiles) return fail("recursive asset listing unavailable");
    const files = fs.listFiles(path.join(pluginPath, SKILL));
    if (!files.includes("SKILL.md")) return fail("canonical skill source unavailable");
    for (const file of files) {
      if (path.isAbsolute(file) || file.split(/[\\/]/).includes("..")) return fail("unsafe skill source path");
      const source = path.join(pluginPath, SKILL, file);
      assets.push({ source, relative: path.join(".claude", SKILL, file), content: fs.readFile(source) });
    }
    const source = path.join(pluginPath, BRIDGE);
    assets.push({ source, relative: path.join(".openrig", BRIDGE), content: fs.readFile(source) });
    for (const asset of assets) {
      const target = path.join(cwd, asset.relative);
      if (!safeTarget(target)) return fail(`preserved unsafe asset path ${JSON.stringify(target)}`);
      if (!fs.exists(target)) continue;
      const recorded = ownership.files[asset.relative];
      if (!recorded || typeof recorded.sha256 !== "string" || digest(fs.readFile(target)) !== recorded.sha256)
        return fail(`preserved unowned or modified asset ${JSON.stringify(target)}`);
    }
  } catch { return fail("required source or existing asset could not be read"); }

  const settingsBefore = JSON.stringify(settings);
  const hooks: Record<string, unknown> = { ...(object(settings["hooks"]) ? settings["hooks"] : {}) };
  for (const [event, groups] of Object.entries(hooks)) {
    if (!Array.isArray(groups)) continue;
    const kept = groups.flatMap(group => {
      if (!object(group) || !Array.isArray(group["hooks"])) return [group];
      const filtered = group["hooks"].filter((hook: unknown) => !object(hook) || !ownedCommand(hook["command"]));
      if (filtered.length === group["hooks"].length) return [group];
      return filtered.length ? [{ ...group, hooks: filtered }] : [];
    });
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  for (const { event, group } of desired) {
    if (hooks[event] !== undefined && !Array.isArray(hooks[event])) return fail(`malformed existing ${event} hooks`);
    hooks[event] = [...(hooks[event] as unknown[] | undefined ?? []), group];
  }
  settings["hooks"] = hooks;

  for (const asset of assets) {
    const target = path.join(cwd, asset.relative);
    if (!fs.exists(target) || fs.readFile(target) !== asset.content) {
      fs.mkdirp(path.dirname(target));
      fs.writeFile(target, asset.content);
      input.recordProjection?.(target, asset.content);
      result.changed = true;
    }
    if (fs.statMode && fs.chmod) {
      const mode = fs.statMode(asset.source) & 0o777;
      if ((fs.statMode(target) & 0o777) !== mode) { fs.chmod(target, mode); result.changed = true; }
    }
    ownership.files[asset.relative] = { sha256: digest(asset.content) };
  }
  const ownershipAfter = JSON.stringify(ownership, null, 2);
  if (ownershipBefore !== ownershipAfter) {
    fs.mkdirp(path.dirname(ownershipPath));
    fs.writeFile(ownershipPath, ownershipAfter);
    result.changed = true;
  }
  if (settingsBefore !== JSON.stringify(settings)) {
    fs.mkdirp(path.dirname(settingsPath));
    fs.writeFile(settingsPath, JSON.stringify(settings, null, 2));
    result.changed = true;
  }
  result.delivered = true;
  return result;
}
