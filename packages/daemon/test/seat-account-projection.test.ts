import { describe, expect, it } from "vitest";
import { CodexRuntimeAdapter } from "../src/adapters/codex-runtime-adapter.js";
import { mergeManagedBlock } from "../src/domain/managed-blocks.js";
import type { ProjectionPlan } from "../src/domain/projection-planner.js";
import type { NodeBinding } from "../src/domain/types.js";

describe("seat-scoped projection", () => {
  it("projects parallel seats into their own account configs, without shared mutable adapter state", async () => {
    const files = new Map<string, string>([["/fragment.toml", '[mcp_servers.test]\ncommand = "node"\n']]);
    const adapter = new CodexRuntimeAdapter({ tmux: {} as never,
      codexHome: "/daemon-home", resolveSeatHome: b => b.tmuxSession === "a@rig" ? "/account-a" : "/account-b",
      fsOps: { readFile: p => files.get(p)!, writeFile: (p, t) => { files.set(p, t); }, exists: p => files.has(p), mkdirp: () => {} } });
    const plan: ProjectionPlan = { runtime: "codex", cwd: "/project", conflicts: [], noOps: [], diagnostics: [], startup: { files: [], actions: [] },
      entries: [{ category: "runtime_resource", effectiveId: "test-mcp", sourceSpec: "test", sourcePath: "/", resourcePath: "fragment.toml", absolutePath: "/fragment.toml", classification: "safe_projection", resourceType: "codex_config_fragment" }] };
    const bindings = ["a@rig", "b@rig"].map(tmuxSession => ({ tmuxSession, cwd: "/project" }) as NodeBinding);
    const results = await Promise.all(bindings.map(b => adapter.project(plan, b)));
    expect(results.every(r => r.failed.length === 0)).toBe(true);
    expect(files.get("/account-a/config.toml")).toContain("mcp_servers.test");
    expect(files.get("/account-b/config.toml")).toContain("mcp_servers.test");
    expect(files.has("/daemon-home/config.toml")).toBe(false);
  });
  it("keeps repeated managed-block projection byte-identical and preserves surrounding user text", () => {
    let body = "User instructions\n";
    const fs = { exists: () => true, readFile: () => body, writeFile: (_p: string, t: string) => { body = t; } };
    mergeManagedBlock(fs, "/workspace/AGENTS.md", "role", "Role"); const first = body;
    for (let i = 0; i < 10; i++) mergeManagedBlock(fs, "/workspace/AGENTS.md", "role", "Role");
    expect(body).toBe(first); expect(body).toContain("User instructions");
  });
});
