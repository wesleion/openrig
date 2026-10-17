import { afterEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { resumeArguments, stageConversation, closeVacantShell } from "../src/domain/provider/native-account-session.js";
import { quotaFromRateLimits, subscriptionEnvironment } from "../src/domain/provider/native-account-probe.js";
import { accountScopedInferenceAt } from "../src/domain/provider/account-cache-scope.js";
const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(f => f()); });
const id = "01a121ad-f543-7f70-802d-d1b26efdb78a";
describe("account replacement native continuity", () => {
  it("closes an empty shell that ignores TERM without forcing a native process", async () => {
    const shell = spawn('/bin/bash', ['--noprofile', '--norc', '-c', 'trap "" TERM; echo ready; read -r value'], { stdio: ['pipe', 'pipe', 'ignore'] });
    try {
      await new Promise<void>(resolve => shell.stdout.once('data', () => resolve()));
      shell.kill('SIGTERM');
      await new Promise(resolve => setTimeout(resolve, 30));
      expect(shell.exitCode).toBeNull();
      const exited = new Promise(resolve => shell.once('exit', resolve));
      expect(closeVacantShell(shell.pid!)).toBe(true);
      await exited;
      expect(shell.signalCode).toBe('SIGHUP');
    } finally { shell.stdin.end(); }
    const native = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    try { expect(closeVacantShell(native.pid!)).toBe(false); }
    finally { native.kill('SIGTERM'); }
  });
  it("keeps Codex permission/model/cwd options and resumes the exact conversation", () => {
    expect(resumeArguments("codex", ["--no-daemon", "-s", "workspace-write", "-C", "/repo", "-m", "gpt", "resume", id, "--last"], id))
      .toEqual(["--no-daemon", "-s", "workspace-write", "-C", "/repo", "-m", "gpt", "resume", id]);
  });
  it("drops a Codex selector that follows resume's own options (no stray PROMPT)", () => {
    const launched = ["--no-daemon", "-m", "gpt", "resume", "--add-dir", "/state", id];
    expect(resumeArguments("codex", launched, id)).toEqual(["--no-daemon", "-m", "gpt", "--add-dir", "/state", "resume", id]);
    // Seats already switched by the old code carry the stray id before `resume`.
    expect(resumeArguments("codex", ["-m", "gpt", "--add-dir", "/state", id, "resume", id], id)).toEqual(["-m", "gpt", "--add-dir", "/state", "resume", id]);
    // A second switch starts from the first one's output and must stay stable.
    expect(resumeArguments("codex", resumeArguments("codex", launched, id), id)).toEqual(resumeArguments("codex", launched, id));
  });
  it("replaces Claude's fresh session selector while preserving native policies", () => {
    expect(resumeArguments("claude-code", ["--permission-mode", "auto", "--session-id", id, "--name", "lead@agency"], id))
      .toEqual(["--permission-mode", "auto", "--name", "lead@agency", "--resume", id]);
    expect(() => resumeArguments("codex", ["exec", "work"], id)).toThrow();
    expect(() => resumeArguments("codex", [], "--last")).toThrow();
  });
  it("copies only one conversation; never copies auth, config or a SQLite database", () => {
    const root = mkdtempSync(path.join(tmpdir(), "conversation-copy-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const source = path.join(root, "source"), target = path.join(root, "target");
    mkdirSync(path.join(source, "sessions", "2026", "10", "09"), { recursive: true }); mkdirSync(target);
    const file = path.join("sessions", "2026", "10", "09", `rollout-${id}.jsonl`);
    writeFileSync(path.join(source, file), '{"type":"session_meta"}\n');
    writeFileSync(path.join(source, "auth.json"), "source-secret");
    writeFileSync(path.join(source, "state_5.sqlite"), "source-db"); writeFileSync(path.join(target, "auth.json"), "target-secret");
    expect(stageConversation(source, { account: "codex-f", runtime: "codex", home: target }, id)).toBe(path.join(target, file));
    expect(readFileSync(path.join(target, "auth.json"), "utf8")).toBe("target-secret");
    expect(() => readFileSync(path.join(target, "state_5.sqlite"))).toThrow();
  });
  it("waits for every depleted window to reset, ignores expired limits and unknown values", () => {
    const now = 1_000_000;
    expect(quotaFromRateLimits({ rateLimits: { primary: { usedPercent: 100, resetsAt: 2000 }, secondary: { usedPercent: 100, resetsAt: 3000 } } }, now))
      .toEqual({ exhausted: true, resetAt: new Date(3_000_000).toISOString(), quotaKnown: true });
    expect(quotaFromRateLimits({ rateLimits: { primary: { usedPercent: 100, resetsAt: 1 } } }, now).exhausted).toBe(false);
    expect(quotaFromRateLimits({}, now)).toEqual({ exhausted: false, resetAt: null, quotaKnown: false });
  });
  it("never carries API billing environment into a subscription probe", () => {
    const before = process.env.OPENAI_API_KEY; process.env.OPENAI_API_KEY = "synthetic";
    try { const env = subscriptionEnvironment({ account: "codex-f", runtime: "codex", home: "/isolated" });
      expect(env.OPENAI_API_KEY).toBeUndefined(); expect(env.CODEX_HOME).toBe("/isolated");
    } finally { before === undefined ? delete process.env.OPENAI_API_KEY : process.env.OPENAI_API_KEY = before; }
  });
  it("preserves conversation baseline but invalidates cache warmth across an account epoch", () => {
    const db = new Database(":memory:"); cleanup.push(() => db.close());
    db.exec("CREATE TABLE provider_account_bindings(node_id TEXT PRIMARY KEY,changed_at TEXT)");
    expect(accountScopedInferenceAt(db, "node", "2026-10-09T10:00:00Z")).toBe("2026-10-09T10:00:00Z");
    db.prepare("INSERT INTO provider_account_bindings VALUES (?,?)").run("node", "2026-10-09T11:00:00Z");
    expect(accountScopedInferenceAt(db, "node", "2026-10-09T10:00:00Z")).toBeNull();
    expect(accountScopedInferenceAt(db, "node", "2026-10-09T11:01:00Z")).toBe("2026-10-09T11:01:00Z");
  });
});
