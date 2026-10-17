import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { SeatAccountHomes } from "../src/domain/provider/seat-account-homes.js";
import { SeatLaunchEnvironment } from "../src/domain/seat-launch-environment.js";

const cleanup: string[] = [];
afterEach(() => { for (const p of cleanup.splice(0)) rmSync(p, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "account-homes-")); cleanup.push(root);
  for (const [ref, file] of [["codex-e", "auth.json"], ["claude-b", ".credentials.json"]]) {
    mkdirSync(path.join(root, ref!)); writeFileSync(path.join(root, ref!, file!), "{}");
  }
  writeFileSync(path.join(root, "seats.conf"), "builder@agency=codex-e\nlead@agency=claude-b\n");
  return { root, homes: new SeatAccountHomes(root) };
}
describe("explicit seat account homes", () => {
  it("selects distinct native environments without relying on PATH wrappers", () => {
    const { root, homes } = fixture();
    expect(homes.environment("builder@agency", "codex")).toEqual({ CODEX_HOME: path.join(root, "codex-e"), OPENRIG_ACCOUNT_REF: "codex-e" });
    expect(homes.environment("lead@agency", "claude-code")).toEqual({ CLAUDE_CONFIG_DIR: path.join(root, "claude-b"), OPENRIG_ACCOUNT_REF: "claude-b" });
    expect(homes.environment("terminal@agency", "terminal")).toEqual({});
    expect(homes.environment("unmapped", "codex")).toEqual({});
  });
  it("fails shut for provider mismatch, duplicate maps and missing credentials", () => {
    const { root, homes } = fixture();
    expect(() => homes.environment("builder@agency", "claude-code")).toThrow(/runtime/);
    writeFileSync(path.join(root, "seats.conf"), "builder@agency=codex-e\nbuilder@agency=codex-e");
    expect(() => homes.mappings()).toThrow(/duplicate/);
    expect(() => homes.account("../../.codex")).toThrow();
    mkdirSync(path.join(root, "codex-f")); expect(() => homes.account("codex-f")).toThrow(/credentials/);
  });
  it("rejects homes outside the registry and never silently falls back on invalid selection", async () => {
    const { root, homes } = fixture();
    symlinkSync(path.dirname(root), path.join(root, "codex-x"));
    expect(() => homes.account("codex-x")).toThrow(/escapes/);
    writeFileSync(path.join(root, "seats.conf"), "builder@agency=codex-missing");
    const launch = new SeatLaunchEnvironment({} as any, { CODEX_HOME: "/global" }, root, undefined, "/global",
      (seat, runtime) => homes.environment(seat, runtime));
    await expect(launch.command("builder@agency", "codex resume native", { codexCwd: root })).rejects.toThrow();
  });
  it("retains a temporary account without changing the principal map", () => {
    const { homes } = fixture();
    mkdirSync(path.join(homes.root, "codex-f")); writeFileSync(path.join(homes.root, "codex-f", "auth.json"), "{}");
    homes.select("builder@agency", "codex-f");
    expect(homes.resolve("builder@agency")?.account).toBe("codex-f");
    expect(homes.mappings().get("builder@agency")).toBe("codex-e");
    homes.select("builder@agency", undefined); expect(homes.resolve("builder@agency")?.account).toBe("codex-e");
  });
});
