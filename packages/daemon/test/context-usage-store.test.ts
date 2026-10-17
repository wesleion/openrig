import { describe, it, expect, beforeEach, afterEach } from "vitest";
import BetterSqlite3, { type Database } from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RigRepository } from "../src/domain/rig-repository.js";
import { ContextUsageStore, FRESHNESS_THRESHOLD_MS } from "../src/domain/context-usage-store.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";


describe("ContextUsageStore", () => {
  let db: Database.Database;
  let rigRepo: RigRepository;
  let store: ContextUsageStore;

  beforeEach(() => {
    db = createDb();
    migrate(db, ALL_MIGRATIONS);
    rigRepo = new RigRepository(db);
    store = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
  });

  afterEach(() => { db.close(); });

  function seedNode(logicalId = "dev.impl") {
    const rig = rigRepo.createRig("test-rig");
    const node = rigRepo.addNode(rig.id, logicalId, { runtime: "claude-code" });
    return { rig, node };
  }

  const VALID_SIDECAR = {
    context_window: {
      context_window_size: 200000,
      used_percentage: 67,
      remaining_percentage: 33,
      total_input_tokens: 120000,
      total_output_tokens: 14000,
      current_usage: "67% used",
    },
    session_id: "sess-123",
    session_name: "dev-impl@test-rig",
    transcript_path: "/tmp/transcripts/test.log",
    sampled_at: new Date().toISOString(),
  };

  const VALID_SIDECAR_WITH_OBJECT_USAGE = {
    ...VALID_SIDECAR,
    context_window: {
      ...VALID_SIDECAR.context_window,
      current_usage: {
        input_tokens: 3,
        output_tokens: 129,
        cache_creation_input_tokens: 79,
        cache_read_input_tokens: 251672,
      },
    },
  };

  // T1: Valid sidecar normalizes into known ContextUsage
  it("valid sidecar JSON normalizes into known ContextUsage", () => {
    const usage = store.normalizeSample(VALID_SIDECAR);
    expect(usage.availability).toBe("known");
    expect(usage.reason).toBeNull();
    expect(usage.source).toBe("claude_statusline_json");
    expect(usage.usedPercentage).toBe(67);
    expect(usage.remainingPercentage).toBe(33);
    expect(usage.contextWindowSize).toBe(200000);
    expect(usage.totalInputTokens).toBe(120000);
    expect(usage.totalOutputTokens).toBe(14000);
    expect(usage.currentUsage).toBe("67% used");
    expect(usage.sessionId).toBe("sess-123");
    expect(usage.sessionName).toBe("dev-impl@test-rig");
    expect(usage.transcriptPath).toBe("/tmp/transcripts/test.log");
    expect(usage.fresh).toBe(true);
  });

  it("object-shaped current_usage is preserved as JSON text", () => {
    const usage = store.normalizeSample(VALID_SIDECAR_WITH_OBJECT_USAGE);
    expect(usage.availability).toBe("known");
    expect(usage.currentUsage).toBe(
      JSON.stringify(VALID_SIDECAR_WITH_OBJECT_USAGE.context_window.current_usage),
    );
  });

  it("Codex token_count JSONL normalizes into known ContextUsage", () => {
    const codexHome = join(tmpdir(), `codex-context-${Date.now()}`);
    const codexDir = join(codexHome, ".codex");
    const rolloutPath = join(codexDir, "sessions", "rollout-thread-1.jsonl");
    mkdirSync(join(codexDir, "sessions"), { recursive: true });

    const stateDbPath = join(codexDir, "state_5.sqlite");
    const stateDb = new BetterSqlite3(stateDbPath);
    try {
      stateDb.prepare("CREATE TABLE threads (id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)").run();
      stateDb.prepare("INSERT INTO threads (id, rollout_path) VALUES (?, ?)").run("thread-1", rolloutPath);
    } finally {
      stateDb.close();
    }

    writeFileSync(rolloutPath, [
      JSON.stringify({ type: "event_msg", payload: { type: "other" } }),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 227139,
              output_tokens: 611,
              total_tokens: 227750,
            },
            model_context_window: 258400,
          },
        },
      }),
    ].join("\n"));

    const codexStore = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test", codexHomeDir: codexHome });
    const usage = codexStore.readCodexAndNormalize({
      threadId: "thread-1",
      sessionName: "dev-qa@test-rig",
    });

    expect(usage.availability).toBe("known");
    expect(usage.reason).toBeNull();
    expect(usage.source).toBe("codex_token_count_jsonl");
    expect(usage.usedPercentage).toBe(88);
    expect(usage.remainingPercentage).toBe(12);
    expect(usage.contextWindowSize).toBe(258400);
    expect(usage.totalInputTokens).toBeNull();
    expect(usage.totalOutputTokens).toBeNull();
    expect(usage.lastInference).toMatchObject({ inputTokens: 227139, outputTokens: 611, totalTokens: 227750 });
    expect(usage.sessionId).toBe("thread-1");
    expect(usage.sessionName).toBe("dev-qa@test-rig");
    expect(usage.transcriptPath).toBe(rolloutPath);
    expect(usage.currentUsage).toContain("\"model_context_window\":258400");

    rmSync(codexHome, { recursive: true, force: true });
  });

  it("keeps cumulative cache totals separate from last-context usage through both persistence projections", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-metric-totals-"));
    const rolloutPath = join(root, "rollout.jsonl");
    const stateDb = new BetterSqlite3(join(root, "state_5.sqlite"));
    stateDb.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    stateDb.prepare("INSERT INTO threads VALUES ('thread-total', ?)").run(rolloutPath);
    stateDb.close();
    const at = new Date().toISOString();
    writeFileSync(rolloutPath, [
      { type: "turn_context", timestamp: at, payload: { model: "gpt-6.1", effort: "high" } },
      { type: "event_msg", timestamp: at, payload: { type: "task_complete" } },
      { type: "event_msg", timestamp: at, payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 800, output_tokens: 100, cached_input_tokens: 600, total_tokens: 900 },
        total_token_usage: { input_tokens: 8000, output_tokens: 1000, cached_input_tokens: 6000, total_tokens: 9000 },
        model_context_window: 10000,
      } } },
    ].map(value => JSON.stringify(value)).join("\n"));
    try {
      const usage = store.readCodexAndNormalize({ threadId: "thread-total", sessionName: "dev-impl@test-rig", codexHome: root });
      expect(usage.usedPercentage).toBe(9);
      expect(usage.totalInputTokens).toBe(8000);
      expect(usage.totalOutputTokens).toBe(1000);
      expect(usage.totalCachedInputTokens).toBe(6000);
      expect(usage.lastInference).toEqual({ inputTokens: 800, outputTokens: 100, cachedInputTokens: 600, totalTokens: 900, at });
      const { node } = seedNode();
      store.persist(node.id, usage);
      const single = store.getForNode(node.id, "dev-impl@test-rig");
      const bulk = store.getForNodes([{ nodeId: node.id, currentSessionName: "dev-impl@test-rig" }]).get(node.id)!;
      for (const restored of [single, bulk]) {
        expect(restored.lastInference).toEqual(usage.lastInference);
        expect(restored.totalCachedInputTokens).toBe(6000);
        expect(restored.execution).toEqual(usage.execution);
        expect(restored.runtimeMetadata).toEqual(usage.runtimeMetadata);
        expect(restored.currentUsage).toEqual(usage.currentUsage);
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("honors one explicit account root and never falls back to the daemon account", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-explicit-home-"));
    const account = join(root, "selected");
    const daemon = join(root, "daemon");
    for (const [home, input] of [[account, 100], [daemon, 700]] as const) {
      mkdirSync(home);
      const rolloutPath = join(home, "rollout.jsonl");
      const state = new BetterSqlite3(join(home, "state_5.sqlite"));
      state.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
      state.prepare("INSERT INTO threads VALUES ('same-thread', ?)").run(rolloutPath);
      state.close();
      writeFileSync(rolloutPath, JSON.stringify({ type: "event_msg", timestamp: new Date().toISOString(),
        payload: { type: "token_count", info: { last_token_usage: { input_tokens: input, output_tokens: 0 }, model_context_window: 1000 } } }));
    }
    try {
      const selected = new ContextUsageStore(db, { stateDir: root, codexHome: daemon });
      expect(selected.readCodexAndNormalize({ threadId: "same-thread", sessionName: "seat", codexHome: account }).usedPercentage).toBe(10);
      expect(selected.readCodexAndNormalize({ threadId: "same-thread", sessionName: "seat" }).usedPercentage).toBe(70);
      expect(selected.readCodexTranscriptPath("same-thread", account)).toBe(join(account, "rollout.jsonl"));
      for (const missing of [join(root, "missing"), "", "relative"]) {
        expect(selected.readCodexAndNormalize({ threadId: "same-thread", sessionName: "seat", codexHome: missing }).availability).toBe("unknown");
        expect(selected.readCodexTranscriptPath("same-thread", missing)).toBeNull();
      }
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves observed Claude cache metrics without inventing accumulated cache", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR_WITH_OBJECT_USAGE);
    expect(usage.lastInference).toMatchObject({ inputTokens: 3, outputTokens: 129, cachedInputTokens: 251672, totalTokens: 251883 });
    expect(usage.totalCachedInputTokens).toBeUndefined();
    store.persist(node.id, usage);
    expect(store.getForNode(node.id, "dev-impl@test-rig").lastInference).toEqual(usage.lastInference);
  });

  it("preserves historical inference time across native adoption only with the current verified generation", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-adoption-proof-"));
    const rolloutPath = join(root, "rollout.jsonl");
    const state = new BetterSqlite3(join(root, "state_5.sqlite"));
    state.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    state.prepare("INSERT INTO threads VALUES ('retained-native-thread', ?)").run(rolloutPath);
    state.close();
    const nativeAt = new Date(Date.now() - 3 * 86400000).toISOString();
    const adoptedAt = new Date(Date.now() - 86400000).toISOString();
    writeFileSync(rolloutPath, JSON.stringify({ timestamp: nativeAt, type: "event_msg",
      payload: { type: "token_count", info: {
        last_token_usage: { input_tokens: 100, output_tokens: 10, cached_input_tokens: 80, total_tokens: 110 },
        total_token_usage: { input_tokens: 900, output_tokens: 100, cached_input_tokens: 800 }, model_context_window: 1000,
      } } }));
    let generation: string | null = "adopted-occupant";
    const options = { stateDir: root, codexHome: root, resolveOccupantBootAt: () => adoptedAt,
      resolveOccupantGeneration: () => generation };
    const observedStore = new ContextUsageStore(db, options);
    const { node } = seedNode();
    try {
      const normalized = observedStore.readCodexAndNormalize({ threadId: "retained-native-thread", sessionName: "dev-impl@test-rig",
        codexHome: root, verifiedGeneration: "adopted-occupant" });
      observedStore.persist(node.id, normalized);
      // A new store simulates daemon restart: provenance is durable, not an in-memory exemption.
      const restarted = new ContextUsageStore(db, options);
      const single = restarted.getForNode(node.id, "dev-impl@test-rig");
      const bulk = restarted.getForNodes([{ nodeId: node.id, currentSessionName: "dev-impl@test-rig" }]).get(node.id)!;
      for (const usage of [single, bulk]) {
        expect(usage.availability).toBe("known");
        expect(usage.usedPercentage).toBe(11);
        expect(usage.sampledAt).toBe(nativeAt);
        expect(usage.lastInference?.at).toBe(nativeAt);
        expect(usage.fresh).toBe(false);
        expect(usage.totalCachedInputTokens).toBe(800);
      }
      generation = "successor-occupant";
      expect(restarted.getForNode(node.id, "dev-impl@test-rig").reason).toBe("stale_generation");
      expect(restarted.getForNodes([{ nodeId: node.id, currentSessionName: "dev-impl@test-rig" }]).get(node.id)?.reason).toBe("stale_generation");
      generation = null;
      expect(restarted.getForNode(node.id, "dev-impl@test-rig").availability).toBe("unknown");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never grants a generation exemption to unverified or daemon-home-only reads", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-no-adoption-proof-"));
    const rolloutPath = join(root, "rollout.jsonl");
    const state = new BetterSqlite3(join(root, "state_5.sqlite"));
    state.exec("CREATE TABLE threads(id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL)");
    state.prepare("INSERT INTO threads VALUES ('thread', ?)").run(rolloutPath);
    state.close();
    const nativeAt = new Date(Date.now() - 3 * 86400000).toISOString();
    const bootAt = new Date(Date.now() - 86400000).toISOString();
    writeFileSync(rolloutPath, JSON.stringify({ timestamp: nativeAt, type: "event_msg", payload: { type: "token_count",
      info: { last_token_usage: { input_tokens: 100 }, model_context_window: 1000 } } }));
    const genStore = new ContextUsageStore(db, { stateDir: root, codexHome: root,
      resolveOccupantBootAt: () => bootAt, resolveOccupantGeneration: () => "current" });
    const { node } = seedNode();
    try {
      for (const selection of [{ codexHome: root }, { verifiedGeneration: "current" }, { codexHome: root, verifiedGeneration: "wrong" }]) {
        const usage = genStore.readCodexAndNormalize({ threadId: "thread", sessionName: "dev-impl@test-rig", ...selection });
        genStore.persist(node.id, usage);
        expect(genStore.getForNode(node.id, "dev-impl@test-rig").reason).toBe("stale_generation");
      }
      // Even a newly written native record cannot revive an explicitly retired UUID.
      writeFileSync(rolloutPath, JSON.stringify({ timestamp: new Date().toISOString(), type: "event_msg", payload: { type: "token_count",
        info: { last_token_usage: { input_tokens: 100 }, model_context_window: 1000 } } }));
      genStore.persist(node.id, genStore.readCodexAndNormalize({ threadId: "thread", sessionName: "dev-impl@test-rig", codexHome: root, verifiedGeneration: "wrong" }));
      expect(genStore.getForNode(node.id, "dev-impl@test-rig").reason).toBe("stale_generation");
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  // T2: Missing sidecar -> unknown with reason
  it("null raw produces unknown with missing_sidecar reason", () => {
    const usage = store.normalizeSample(null);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
    expect(usage.usedPercentage).toBeNull();
    expect(usage.fresh).toBe(false);
  });

  // T3: Invalid JSON (missing context_window) -> parse_error
  it("raw without context_window produces unknown with parse_error", () => {
    const usage = store.normalizeSample({ session_id: "x" } as any);
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("parse_error");
  });

  // T4: Stale sample -> fresh=false but values retained
  it("stale sample has fresh=false but retains persisted values", () => {
    const stale = {
      ...VALID_SIDECAR,
      sampled_at: new Date(Date.now() - FRESHNESS_THRESHOLD_MS - 60_000).toISOString(),
    };
    const usage = store.normalizeSample(stale);
    expect(usage.availability).toBe("known");
    expect(usage.fresh).toBe(false);
    expect(usage.usedPercentage).toBe(67); // values retained, not erased
  });

  // T5: persist + getForNode round-trip
  it("persist upserts, getForNode retrieves with freshness", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const retrieved = store.getForNode(node.id, "dev-impl@test-rig");
    expect(retrieved.availability).toBe("known");
    expect(retrieved.usedPercentage).toBe(67);
    expect(retrieved.sessionName).toBe("dev-impl@test-rig");
  });

  // T6: getForNode on nonexistent node -> unknown
  it("getForNode on nonexistent node returns unknown", () => {
    const result = store.getForNode("nonexistent", "some-session");
    expect(result.availability).toBe("unknown");
    expect(result.reason).toBe("no_data");
  });

  // T7: unknownUsage factory
  it("unknownUsage produces correct shape", () => {
    const usage = store.unknownUsage("unsupported_runtime");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("unsupported_runtime");
    expect(usage.usedPercentage).toBeNull();
    expect(usage.fresh).toBe(false);
    expect(usage.source).toBeNull();
  });

  // OPR.0.5.9.5 Wave A: runtime telemetry belongs beneath state/, leaving
  // $OPENRIG_HOME/context available for the addressable context library.
  it("getSidecarPath returns path under state/context-usage/", () => {
    const path = store.getSidecarPath("dev-impl@test-rig");
    expect(path).toBe("/tmp/openrig-test/state/context-usage/dev-impl@test-rig.json");
  });

  // T9: Freshness threshold is centralized
  it("FRESHNESS_THRESHOLD_MS is exported and used consistently", () => {
    expect(typeof FRESHNESS_THRESHOLD_MS).toBe("number");
    expect(FRESHNESS_THRESHOLD_MS).toBe(600_000);
  });

  // T10: context_usage row cascades on node delete
  it("context_usage cascades on node delete", () => {
    const { rig, node } = seedNode();
    store.persist(node.id, store.normalizeSample(VALID_SIDECAR));

    // Verify row exists
    const before = db.prepare("SELECT COUNT(*) as c FROM context_usage WHERE node_id = ?").get(node.id) as { c: number };
    expect(before.c).toBe(1);

    // Delete the node (cascade should remove context_usage)
    db.prepare("DELETE FROM nodes WHERE id = ?").run(node.id);

    const after = db.prepare("SELECT COUNT(*) as c FROM context_usage WHERE node_id = ?").get(node.id) as { c: number };
    expect(after.c).toBe(0);
  });

  // T11: getForNode session mismatch -> unknown
  it("getForNode returns unknown when session_name mismatches", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const result = store.getForNode(node.id, "different-session@new-rig");
    expect(result.availability).toBe("unknown");
    expect(result.reason).toBe("session_mismatch");
  });

  // T12: getForNodes batch session mismatch
  it("getForNodes returns unknown for mismatched sessions in batch", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: "different-session" },
    ]);

    expect(results.get(node.id)?.availability).toBe("unknown");
    expect(results.get(node.id)?.reason).toBe("session_mismatch");
  });

  // T12b: getForNodes with null currentSessionName -> not_managed
  it("getForNodes returns unknown for null currentSessionName", () => {
    const { node } = seedNode();
    store.persist(node.id, store.normalizeSample(VALID_SIDECAR));

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: null },
    ]);

    expect(results.get(node.id)?.availability).toBe("unknown");
    expect(results.get(node.id)?.reason).toBe("not_managed");
  });

  // T14: readSidecar missing file -> { ok: false, reason: 'missing_sidecar' }
  it("readSidecar returns missing_sidecar for nonexistent file", () => {
    const result = store.readSidecar("nonexistent-session");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("missing_sidecar");
  });

  it("reads canonical context usage first and falls back to the legacy 0.5.8 sidecar only when canonical is absent", () => {
    const home = join(tmpdir(), `context-bridge-${Date.now()}`);
    const sessionName = "dev-impl@test-rig";
    const canonical = join(home, "state", "context-usage", `${sessionName}.json`);
    const legacy = join(home, "context", `${sessionName}.json`);
    mkdirSync(join(home, "state", "context-usage"), { recursive: true });
    mkdirSync(join(home, "context"), { recursive: true });
    writeFileSync(legacy, JSON.stringify({
      ...VALID_SIDECAR,
      context_window: { ...VALID_SIDECAR.context_window, used_percentage: 41 },
    }));

    const bridge = new ContextUsageStore(db, { stateDir: home });
    expect(bridge.readAndNormalize(sessionName).usedPercentage).toBe(41);

    writeFileSync(canonical, JSON.stringify({
      ...VALID_SIDECAR,
      context_window: { ...VALID_SIDECAR.context_window, used_percentage: 73 },
    }));
    expect(bridge.readAndNormalize(sessionName).usedPercentage).toBe(73);

    writeFileSync(canonical, "not json");
    expect(bridge.readAndNormalize(sessionName).reason).toBe("parse_error");
    rmSync(home, { recursive: true, force: true });
  });

  // T15: readSidecar invalid JSON file -> { ok: false, reason: 'parse_error' }
  it("readSidecar returns parse_error for invalid JSON sidecar file", () => {
    const tmpDir = join(tmpdir(), `context-test-${Date.now()}`);
    const contextDir = join(tmpDir, "state", "context-usage");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "bad-session.json"), "this is not json {{{");

    const tmpStore = new ContextUsageStore(db, { stateDir: tmpDir });
    const result = tmpStore.readSidecar("bad-session");
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe("parse_error");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // T16: readAndNormalize distinguishes missing vs parse_error through full path
  it("readAndNormalize produces missing_sidecar for missing file", () => {
    const usage = store.readAndNormalize("totally-missing");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("missing_sidecar");
  });

  it("readAndNormalize produces parse_error for invalid JSON file", () => {
    const tmpDir = join(tmpdir(), `context-test-parse-${Date.now()}`);
    const contextDir = join(tmpDir, "state", "context-usage");
    mkdirSync(contextDir, { recursive: true });
    writeFileSync(join(contextDir, "corrupt.json"), "not valid json!!!");

    const tmpStore = new ContextUsageStore(db, { stateDir: tmpDir });
    const usage = tmpStore.readAndNormalize("corrupt");
    expect(usage.availability).toBe("unknown");
    expect(usage.reason).toBe("parse_error");

    rmSync(tmpDir, { recursive: true, force: true });
  });

  // T13: getForNodes returns known for matching sessions
  it("getForNodes returns known for matching sessions in batch", () => {
    const { node } = seedNode();
    const usage = store.normalizeSample(VALID_SIDECAR);
    store.persist(node.id, usage);

    const results = store.getForNodes([
      { nodeId: node.id, currentSessionName: "dev-impl@test-rig" },
    ]);

    expect(results.get(node.id)?.availability).toBe("known");
    expect(results.get(node.id)?.usedPercentage).toBe(67);
  });

  // ── GHOST-STAGE (c-id): generation guard ──────────────────────────────────
  // Under handover the successor RESUMES INTO THE SAME PANE and REUSES the name, so
  // session_mismatch cannot catch the retiree's frozen reading. The generation guard rejects a
  // reading sampled BEFORE the live occupant booted (atom-B tenure boot_at) — evaluate current-gen
  // only; a pre-boot sample reports insufficient-data, never the frozen percentage.
  describe("c-id generation guard", () => {
    let genStore: ContextUsageStore;
    let bootAtByNode: Map<string, string | null>;

    beforeEach(() => {
      bootAtByNode = new Map();
      genStore = new ContextUsageStore(db, {
        stateDir: "/tmp/openrig-test",
        resolveOccupantBootAt: (nodeId) => bootAtByNode.get(nodeId) ?? null,
      });
    });

    // A reading carrying the frozen 88% from the RETIRED generation, name reused (so it survives
    // session_mismatch). sampledAt lets each test place it relative to the successor's boot.
    function persistFrozen(nodeId: string, sampledAtIso: string) {
      genStore.persist(nodeId, genStore.normalizeSample({
        ...VALID_SIDECAR,
        session_name: "dev-impl@test-rig",
        sampled_at: sampledAtIso,
        context_window: { ...VALID_SIDECAR.context_window, used_percentage: 88, remaining_percentage: 12 },
      }));
    }

    // MIXED-GEN WINDOW: successor booted AFTER the retiree's last sample; only the pre-boot reading
    // exists → insufficient-data (stale_generation), and the frozen 88% must NOT leak through.
    it("rejects a pre-boot reading and does not leak the frozen percentage (mixed-gen window)", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:00:00.000Z");
      bootAtByNode.set(node.id, "2026-08-07T08:05:00.000Z"); // successor booted 5m later
      const result = genStore.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("unknown");
      expect(result.reason).toBe("stale_generation");
      expect(result.usedPercentage).toBeNull(); // the 88 is not evaluated across the boundary
    });

    it("admits a reading sampled AT/AFTER the live occupant booted (current generation)", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:10:00.000Z"); // sampled after boot
      bootAtByNode.set(node.id, "2026-08-07T08:05:00.000Z");
      const result = genStore.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("known");
      expect(result.usedPercentage).toBe(88);
    });

    it("admits a reading sampled exactly at boot (strict-before is the boundary)", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:05:00.000Z");
      bootAtByNode.set(node.id, "2026-08-07T08:05:00.000Z");
      const result = genStore.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("known");
    });

    // NOTE-2: absent tenure = UNKNOWN, never treat unknown as stale. Gate goes inert; the reading
    // still faces session_mismatch + freshness, but is not rejected as prior-gen.
    it("leaves the gate inert when boot time is UNKNOWN (absent tenure)", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:00:00.000Z");
      bootAtByNode.set(node.id, null);
      const result = genStore.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("known");
    });

    it("applies the same guard in the batch path (getForNodes)", () => {
      const { node } = seedNode();
      persistFrozen(node.id, "2026-08-07T08:00:00.000Z");
      bootAtByNode.set(node.id, "2026-08-07T08:05:00.000Z");
      const results = genStore.getForNodes([{ nodeId: node.id, currentSessionName: "dev-impl@test-rig" }]);
      expect(results.get(node.id)?.reason).toBe("stale_generation");
    });

    it("never gates when no resolver is wired (opt-in)", () => {
      const plain = new ContextUsageStore(db, { stateDir: "/tmp/openrig-test" });
      const { node } = seedNode();
      plain.persist(node.id, plain.normalizeSample({
        ...VALID_SIDECAR, session_name: "dev-impl@test-rig", sampled_at: "2026-08-07T08:00:00.000Z",
      }));
      const result = plain.getForNode(node.id, "dev-impl@test-rig");
      expect(result.availability).toBe("known");
    });
  });
});
