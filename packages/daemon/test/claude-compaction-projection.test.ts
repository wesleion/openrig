import { afterEach, expect, it } from "vitest";
import * as fs from "node:fs";
import path from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { ClaudeCodeAdapter, type ClaudeAdapterFsOps } from "../src/adapters/claude-code-adapter.js";
import { reconcileClaudeCompactionProjection, isCanonicalClaudeCompactionPlugin } from "../src/adapters/claude-compaction-projection.js";
import type { NodeBinding } from "../src/domain/runtime-adapter.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";

const pluginPath = fileURLToPath(new URL("../assets/plugins/openrig-core", import.meta.url));
const homes: string[] = [];
afterEach(() => { for (const home of homes.splice(0)) fs.rmSync(home, { recursive: true, force: true }); });

function fixture() {
  const home = fs.mkdtempSync(path.join(tmpdir(), "compaction-projection-")); homes.push(home);
  const cwd = path.join(home, "O'Brien project"); fs.mkdirSync(cwd);
  let writes = 0;
  const walk = (dir: string): string[] => fs.readdirSync(dir, { withFileTypes: true }).flatMap(entry => entry.isDirectory()
    ? walk(path.join(dir, entry.name)).map(file => path.join(entry.name, file)) : [entry.name]);
  const ops: ClaudeAdapterFsOps = {
    readFile: p => fs.readFileSync(p, "utf8"), writeFile: (p, content) => { fs.writeFileSync(p, content); writes++; },
    exists: fs.existsSync, mkdirp: p => { fs.mkdirSync(p, { recursive: true }); }, copyFile: fs.copyFileSync,
    listFiles: walk, statMode: p => fs.statSync(p).mode, chmod: fs.chmodSync,
    inspectPath: p => {
      try { const stat = fs.lstatSync(p); return stat.isSymbolicLink() ? "symlink" : stat.isDirectory() ? "directory" : stat.isFile() ? "file" : "other"; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing"; throw error; }
    },
  };
  const settings = path.join(cwd, ".claude", "settings.local.json");
  const skill = path.join(cwd, ".claude", "skills", "claude-compaction-restore", "SKILL.md");
  const ownership = path.join(cwd, ".openrig", "hooks", "compaction-assets.json");
  const write = (p: string, content: string) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); };
  const reconcile = () => reconcileClaudeCompactionProjection({ fs: ops, cwd, pluginPath });
  return { home, cwd, ops, settings, skill, ownership, write, reconcile, writes: () => writes };
}

it("projects a discoverable complete skill and exactly four hooks; second projection writes nothing", () => {
  const f = fixture();
  const user = { hooks: { Stop: [{ hooks: [{ type: "command", command: "echo user" }] }] }, env: { USER_SETTING: "kept" } };
  f.write(f.settings, JSON.stringify(user));
  expect(isCanonicalClaudeCompactionPlugin(f.ops, pluginPath)).toBe(true);
  expect(f.reconcile()).toMatchObject({ delivered: true, changed: true, warnings: [] });
  expect(fs.readFileSync(f.skill, "utf8")).toBe(fs.readFileSync(path.join(pluginPath, "skills/claude-compaction-restore/SKILL.md"), "utf8"));
  expect(fs.existsSync(path.join(path.dirname(f.skill), "scripts/precompact-hook.mjs"))).toBe(true);
  const settings = JSON.parse(fs.readFileSync(f.settings, "utf8"));
  expect(settings.env).toEqual(user.env); expect(settings.hooks.Stop).toEqual(user.hooks.Stop);
  expect(Object.keys(settings.hooks).sort()).toEqual(["PostCompact", "PreCompact", "SessionStart", "Stop", "UserPromptSubmit"]);
  for (const event of ["SessionStart", "UserPromptSubmit", "PreCompact", "PostCompact"]) {
    expect(settings.hooks[event]).toHaveLength(1); expect(settings.hooks[event][0].hooks).toHaveLength(1);
    const command = settings.hooks[event][0].hooks[0].command;
    expect(command).not.toContain("CLAUDE_PLUGIN_ROOT"); expect(command).not.toContain("activity-relay"); expect(command).not.toContain("refocus");
  }
  expect(settings.hooks.SessionStart[0].matcher).toBe("compact");
  const prior = f.writes(), bytes = fs.readFileSync(f.settings, "utf8");
  expect(f.reconcile()).toMatchObject({ delivered: true, changed: false });
  expect(f.writes()).toBe(prior); expect(fs.readFileSync(f.settings, "utf8")).toBe(bytes);
});

for (const modified of [false, true]) it(`preserves ${modified ? "user-modified owned" : "unowned"} skill and gives original-file fallback`, () => {
  const f = fixture(); if (modified) expect(f.reconcile().delivered).toBe(true);
  f.write(f.skill, "User-authored restore instructions.");
  const settings = fs.existsSync(f.settings) ? fs.readFileSync(f.settings, "utf8") : null;
  const writes = f.writes(), result = f.reconcile();
  expect(result.delivered).toBe(false); expect(result.fallbackSkillPath).toBe(path.join(pluginPath, "skills/claude-compaction-restore/SKILL.md"));
  expect(result.warnings.join(" ")).toContain("preserved unowned or modified asset");
  expect(fs.readFileSync(f.skill, "utf8")).toBe("User-authored restore instructions."); expect(f.writes()).toBe(writes);
  expect(fs.existsSync(f.settings) ? fs.readFileSync(f.settings, "utf8") : null).toBe(settings);
});

for (const target of ["settings", "ownership"]) it(`malformed ${target} remains byte-for-byte intact`, () => {
  const f = fixture(), p = target === "settings" ? f.settings : f.ownership;
  f.write(p, "{ broken user JSON\n");
  const result = f.reconcile(); expect(result.delivered).toBe(false); expect(f.writes()).toBe(0);
  expect(fs.readFileSync(p, "utf8")).toBe("{ broken user JSON\n"); expect(fs.existsSync(f.skill)).toBe(false);
});

it("a previously owned file changed to an outside symlink is never followed", () => {
  const f = fixture(); expect(f.reconcile().delivered).toBe(true);
  const outside = path.join(f.home, "outside.md"); f.write(outside, "Private user file.");
  fs.unlinkSync(f.skill); fs.symlinkSync(outside, f.skill);
  const writes = f.writes(); expect(f.reconcile().delivered).toBe(false); expect(f.writes()).toBe(writes);
  expect(fs.lstatSync(f.skill).isSymbolicLink()).toBe(true); expect(fs.readFileSync(outside, "utf8")).toBe("Private user file.");
});

it("a symlinked target directory is preserved without creating outside assets", () => {
  const f = fixture(), outside = path.join(f.home, "outside"); fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(f.cwd, ".claude"), "dir");
  expect(f.reconcile().delivered).toBe(false); expect(f.writes()).toBe(0); expect(fs.readdirSync(outside)).toEqual([]);
});

it("user composed commands remain intact and absence on a sibling seat does not strip hooks", async () => {
  const f = fixture();
  const user = { type: "command", command: `echo node '${f.cwd}/.openrig/hooks/scripts/compaction-restore-bridge.cjs'` };
  f.write(f.settings, JSON.stringify({ hooks: { UserPromptSubmit: [{ hooks: [user] }] } }));
  expect(f.reconcile().delivered).toBe(true);
  const settings = fs.readFileSync(f.settings, "utf8");
  expect(JSON.parse(settings).hooks.UserPromptSubmit[0].hooks).toEqual([user]);
  const adapter = new ClaudeCodeAdapter({ tmux: {} as any, fsOps: f.ops });
  const binding = { cwd: f.cwd, nodeId: "sibling", tmuxSession: "sibling@rig" } as NodeBinding;
  await adapter.project({ entries: [], runtime: "claude-code", cwd: f.cwd } as unknown as ProjectionPlan, binding);
  expect(fs.readFileSync(f.settings, "utf8")).toBe(settings); expect(fs.existsSync(f.skill)).toBe(true);
});

it("adapter selected canonical plugin projects native assets without enabling the whole plugin", async () => {
  const f = fixture(), adapter = new ClaudeCodeAdapter({ tmux: {} as any, fsOps: f.ops });
  const binding = { cwd: f.cwd, nodeId: "writer", tmuxSession: "writer@rig" } as NodeBinding;
  const plan = { entries: [{ category: "plugin", classification: "safe_projection", effectiveId: "shared:openrig-core", absolutePath: pluginPath, pluginType: "claude" }], runtime: "claude-code", cwd: f.cwd } as unknown as ProjectionPlan;
  const result = await adapter.project(plan, binding);
  expect(result.projected).toContain("shared:openrig-core"); expect(result.warnings ?? []).toEqual([]);
  expect(fs.existsSync(f.skill)).toBe(true);
  expect(JSON.parse(fs.readFileSync(f.settings, "utf8")).enabledPlugins).toBeUndefined();
});
