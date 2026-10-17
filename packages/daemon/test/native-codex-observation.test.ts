import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile, spawn } from "node:child_process";
import { promisify } from "node:util";
import { once } from "node:events";
import { readNativeCodexObservation, resolveCodexHomeByPid, readCodexCatalogDefault } from "../src/domain/native-codex-observation.js";

const scratch = new Set<string>();
afterEach(() => { for (const root of scratch) rmSync(root, { recursive: true, force: true }); scratch.clear(); });
function rollout(records: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "native-codex-metrics-"));
  scratch.add(root);
  const path = join(root, "rollout.jsonl");
  writeFileSync(path, records.map(record => typeof record === "string" ? record : JSON.stringify(record)).join("\n"));
  return path;
}

describe("native Codex observation", () => {
  it("reads the default for the selected model and account only", () => {
    const path = rollout([]), root = path.slice(0, path.lastIndexOf("/"));
    writeFileSync(join(root,"models_cache.json"), JSON.stringify({fetched_at:"2026-10-08T10:00:00Z",models:[
      {slug:"another-model",default_reasoning_level:"high",supported_reasoning_levels:[{effort:"high"}]},
      {slug:"selected",default_reasoning_level:"low",supported_reasoning_levels:[{effort:"low"}]},
    ]}));
    expect(readCodexCatalogDefault(root,"selected")).toEqual({effort:"low",sampledAt:"2026-10-08T10:00:00Z"});
    expect(readCodexCatalogDefault(root,"missing")).toBeNull();
    expect(readCodexCatalogDefault(root+"-other-account","selected")).toBeNull();
  });
  it("rejects malformed, unsupported and oversized catalog defaults", () => {
    const path = rollout([]), root = path.slice(0, path.lastIndexOf("/")),file=join(root,"models_cache.json");
    for(const content of ["{broken",JSON.stringify({models:[{slug:"selected",default_reasoning_level:"high",supported_reasoning_levels:[{effort:"low"}]}]})," ".repeat(2_000_001)]) {
      writeFileSync(file,content);
      expect(readCodexCatalogDefault(root,"selected")).toBeNull();
    }
  });
  it("distinguishes a recorded runtime default from missing reasoning metadata", () => {
    const observed = readNativeCodexObservation(rollout([
      { type: "turn_context", timestamp: "2026-10-08T10:00:00Z", payload: { model: "current", effort: "high" } },
      { type: "turn_context", timestamp: "2026-10-08T10:00:01Z", payload: { model: "current", collaboration_mode: { settings: { reasoning_effort: null } } } },
    ]));
    expect(observed.runtimeMetadata).toMatchObject({ model: "current", effort: "default" });
  });

  it("extracts latest actual metadata and distinct execution/inference times without returning message bodies", () => {
    const path = rollout([
      { type: "turn_context", timestamp: "2026-10-08T10:00:00Z", payload: { model: "old", effort: "low" } },
      { type: "event_msg", timestamp: "2026-10-08T10:00:01Z", payload: { type: "task_started" } },
      { type: "turn_context", timestamp: "2026-10-08T10:00:02Z", payload: { model: "current", collaboration_mode: { settings: { reasoning_effort: "high" } } } },
      { type: "response_item", payload: { type: "message", content: "PRIVATE_MESSAGE_SENTINEL" } },
      { type: "event_msg", timestamp: "2026-10-08T10:00:03Z", payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 200, output_tokens: 10, cached_input_tokens: 150, total_tokens: 210 },
        total_token_usage: { input_tokens: 1000, output_tokens: 50, cached_input_tokens: 800, total_tokens: 1050 },
        model_context_window: 10000, unused_message: "PRIVATE_MESSAGE_SENTINEL",
      } } },
      { type: "event_msg", timestamp: "2026-10-08T10:00:04Z", payload: { type: "task_complete" } },
      "{corrupt final record",
    ]);
    const observed = readNativeCodexObservation(path);
    expect(observed.runtimeMetadata).toEqual({ model: "current", effort: "high", sampledAt: "2026-10-08T10:00:02Z", source: "codex_rollout_jsonl" });
    expect(observed.execution).toEqual({ startedAt: "2026-10-08T10:00:01Z", completedAt: "2026-10-08T10:00:04Z", lastModelResponseAt: "2026-10-08T10:00:03Z", source: "codex_rollout_jsonl" });
    expect(observed.tokenCount?.payload?.info?.last_token_usage?.cached_input_tokens).toBe(150);
    expect(observed.tokenCount?.payload?.info?.total_token_usage?.cached_input_tokens).toBe(800);
    expect(JSON.stringify(observed)).not.toContain("PRIVATE_MESSAGE_SENTINEL");
  });

  it("does not inherit old effort when the newest native context has none", () => {
    const observed = readNativeCodexObservation(rollout([
      { type: "turn_context", timestamp: "2026-10-08T10:00:00Z", payload: { model: "old", effort: "high" } },
      { type: "world_state", timestamp: "2026-10-08T10:00:01Z", payload: { state: { collaboration_mode: { settings: { model: "new" } } } } },
    ]));
    expect(observed.runtimeMetadata).toMatchObject({ model: "new", effort: null });
    expect(observed.tokenCount).toBeNull();
    expect(observed.execution.startedAt).toBeNull();
    expect(observed.execution.completedAt).toBeNull();
    expect(observed.execution.lastModelResponseAt).toBeNull();
  });

  it("recovers metadata cut across a backward window boundary", () => {
    const path = rollout([
      { type: "turn_context", timestamp: "2026-10-08T10:00:00Z", payload: { model: "straddled", effort: "medium", padding: "x".repeat(40000) } },
      { type: "response_item", payload: { padding: "x".repeat(500000) } },
      { type: "event_msg", timestamp: "2026-10-08T10:00:01Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 10 }, model_context_window: 1000 } } },
    ]);
    expect(readNativeCodexObservation(path).runtimeMetadata.model).toBe("straddled");
  });

  it("bounds scans behind a giant message and keeps missing facts unknown", () => {
    const path = rollout([
      { type: "turn_context", timestamp: "2026-10-08T10:00:00Z", payload: { model: "outside-budget" } },
      { type: "response_item", payload: { padding: "x".repeat(8_100_000) } },
      { type: "event_msg", timestamp: "2026-10-08T10:00:02Z", payload: { type: "token_count", info: { last_token_usage: { input_tokens: 20 }, model_context_window: 1000 } } },
    ]);
    const observed = readNativeCodexObservation(path);
    expect(observed.runtimeMetadata.model).toBeNull();
    expect(observed.tokenCount?.payload?.info?.last_token_usage?.input_tokens).toBe(20);
    expect(readNativeCodexObservation(path, 0).tokenCount).toBeNull();
    expect(readNativeCodexObservation(path + ".missing").runtimeMetadata.model).toBeNull();
  });

  it.runIf(process.platform === "linux")("reads only the identity-matched process root and rejects a mismatched identity", async () => {
    const root = mkdtempSync(join(tmpdir(), "codex-process-root-"));
    scratch.add(root);
    const child = spawn(process.execPath, ["-e", "process.stdout.write('ready'); setInterval(() => {}, 1000)"], {
      env: { ...process.env, CODEX_HOME: join(root, "selected"), HOME: join(root, "unrelated") },
      stdio: ["ignore", "pipe", "ignore"],
    });
    try {
      await once(child.stdout!, "data");
      const { stdout } = await promisify(execFile)("ps", ["-p", String(child.pid), "-o", "lstart="], { encoding: "utf8" });
      expect(await resolveCodexHomeByPid(child.pid!, stdout.trim())).toBe(join(root, "selected"));
      expect(await resolveCodexHomeByPid(child.pid!, stdout.trim())).toBe(join(root, "selected"));
      expect(await resolveCodexHomeByPid(child.pid!, "not-the-process-identity")).toBeNull();
    } finally {
      const exit = once(child, "exit");
      child.kill();
      await exit;
    }
  });
});
