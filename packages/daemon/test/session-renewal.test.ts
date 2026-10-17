import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { SessionRenewalStore, currentContextInput, readFirstNativeInput, validateSessionRenewal } from "../src/domain/session-renewal-store.js";
import { SessionRenewalService, type RenewalDeps, type RenewalSeat } from "../src/domain/session-renewal-service.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { ContextUsageStore } from "../src/domain/context-usage-store.js";
import type { ContextUsage } from "../src/domain/types.js";

const cleanup: Array<() => void> = [];
afterEach(() => { cleanup.splice(0).reverse().forEach(fn => fn()); });
function usage(overrides: Partial<ContextUsage> = {}): ContextUsage {
  return { availability: "known", reason: null, source: "codex_token_count_jsonl", usedPercentage: 50,
    remainingPercentage: 50, contextWindowSize: 200_000, totalInputTokens: 900_000,
    totalOutputTokens: 500, currentUsage: null, transcriptPath: null, sessionId: "native-1", sessionName: "worker@project",
    sampledAt: "2026-10-08T10:00:00Z", fresh: false,
    lastInference: { inputTokens: 100_000, cachedInputTokens: 90_000, outputTokens: 500,
      totalTokens: 100_500, at: "2026-10-08T10:00:00Z" }, ...overrides };
}
function setup(overrides: Partial<RenewalDeps> = {}) {
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const rigs = new RigRepository(db), rig = rigs.createRig("project");
  const node = rigs.addNode(rig.id, "worker", { runtime: "codex" });
  db.prepare("INSERT INTO bindings(id,node_id,tmux_session,tmux_pane) VALUES (?,?,?,?)")
    .run("binding-worker", node.id, "worker@project", "%1");
  rigs.setRigSessionRenewal(rig.id, { enabled: true });
  const store = new SessionRenewalStore(db);
  let seat: RenewalSeat = { nodeId: node.id, sessionName: "worker@project", generation: "generation-1",
    usage: usage(), idle: true, protected: false, ready: true };
  function baseline(tokens = 20_000) {
    db.prepare("INSERT OR REPLACE INTO session_renewal_baselines VALUES (?,?,?,?,?)")
      .run(node.id, seat.usage.source, seat.usage.sessionId, tokens, "2026-10-08T09:00:00Z");
  }
  baseline();
  let tail: Promise<unknown> = Promise.resolve();
  const handover = vi.fn(async (_seat: RenewalSeat, _mode: string, check: () => Promise<boolean>) => {
    if (!await check()) return { ok: false, detail: "guard_changed" };
    seat = { ...seat, generation: "generation-2", usage: usage({ sessionId: "native-2" }) };
    return { ok: true };
  });
  const verify = vi.fn(async () => seat.ready ? seat.sessionName : null);
  const escalate = vi.fn(async () => {});
  const deps: RenewalDeps = { db, resolve: () => ({ nodeId: node.id, sessionName: seat.sessionName }),
    inspect: async () => seat, verifyRecipient: verify, handover, escalate,
    exclusive: (_node, fn) => { const operation = tail.then(fn); tail = operation.catch(() => {}); return operation; },
    now: () => new Date("2026-10-08T12:00:00Z"), ...overrides };
  const service = new SessionRenewalService(deps);
  const send = vi.fn(async () => ({ ok: true, verified: true }));
  const queue = new QueueRepository(db, new EventBus(db), { validateRig: () => true, transport: { send } });
  queue.attachBeforeWake((id, dest) => service.beforeWake(id, dest));
  async function item(id = "work-1") {
    await queue.create({ qitemId: id, sourceSession: "sender@project", destinationSession: seat.sessionName, body: "A task", nudge: false });
    return id;
  }
  return { db, rigs, rig, node, store, deps, service, queue, send, handover, verify, escalate, item, baseline,
    get seat() { return seat; }, set seat(value: RenewalSeat) { seat = value; } };
}

describe("native input normalization and baseline evidence", () => {
  it("does not add Codex cached tokens a second time or use billing totals", () => {
    expect(currentContextInput(usage())).toEqual({ tokens: 100_000, source: "native" });
  });
  it("includes Claude read and creation once, excludes output", () => {
    expect(currentContextInput(usage({ source: "claude_statusline_json", lastInference: {
      inputTokens: 100, cachedInputTokens: 20_000, cacheCreationInputTokens: 5_000,
      outputTokens: 200, totalTokens: 25_300, at: null,
    } }))).toEqual({ tokens: 25_100, source: "native" });
  });
  it("supports old Claude envelopes and marks percentage fallback as an estimate", () => {
    expect(currentContextInput(usage({ source: "claude_statusline_json" }))).toEqual({ tokens: 100_000, source: "native" });
    expect(currentContextInput(usage({ lastInference: undefined, usedPercentage: 25 }))).toEqual({ tokens: 50_000, source: "estimate" });
    expect(currentContextInput(usage({ availability: "unknown" }))).toBeNull();
    expect(currentContextInput(usage({ lastInference: undefined, usedPercentage: null }))).toBeNull();
  });
  it.each(["codex_token_count_jsonl", "claude_statusline_json"] as const)("finds the first post-startup inference for %s", source => {
    const dir = mkdtempSync(join(tmpdir(), "renewal-baseline-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const path = join(dir, "session.jsonl");
    const event = (at: string, tokens: number) => source === "codex_token_count_jsonl"
      ? { type: "event_msg", timestamp: at, payload: { type: "token_count", info: { last_token_usage: { input_tokens: tokens } } } }
      : { type: "assistant", sessionId: "native-1", timestamp: at,
          message: { role: "assistant", model: "claude-test", usage: { input_tokens: tokens - 10, cache_read_input_tokens: 5, cache_creation_input_tokens: 5 } } };
    writeFileSync(path, [{ type: "session_meta", payload: { id: "native-1" } },
      event("2026-10-08T08:00:00Z", 10_000), event("2026-10-08T09:00:01Z", 20_000),
      event("2026-10-08T10:00:00Z", 100_000)].map(JSON.stringify).join("\n"));
    expect(readFirstNativeInput(usage({ source, transcriptPath: path }), "2026-10-08T09:00:00Z"))
      .toEqual({ tokens: 20_000, at: "2026-10-08T09:00:01Z" });
    expect(readFirstNativeInput(usage({ source, transcriptPath: path, sessionId: "another-session" }), "2026-10-08T09:00:00Z")).toBeNull();
  });
  it("never invents a baseline from the latest sample when the transcript is missing", () => {
    expect(readFirstNativeInput(usage(), "2026-10-08T09:00:00Z")).toBeNull();
  });
  it("ages Claude cache from a real response, not a fresh statusline render", () => {
    const f = setup();
    const dir = mkdtempSync(join(tmpdir(), "renewal-clock-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const transcript = join(dir, "claude.jsonl");
    writeFileSync(transcript, JSON.stringify({ type: "assistant", sessionId: "native-1", timestamp: "2026-10-08T10:00:00Z",
      message: { role: "assistant", model: "claude-test", usage: { input_tokens: 100, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 } } }));
    const context = new ContextUsageStore(f.db, { stateDir: dir });
    const raw = { session_id: "native-1", session_name: "worker@project", transcript_path: transcript, sampled_at: "2026-10-08T12:00:00Z",
      context_window: { used_percentage: 10, context_window_size: 200_000,
        current_usage: { input_tokens: 100, output_tokens: 100, cache_read_input_tokens: 20_000, cache_creation_input_tokens: 0 } } };
    const normalized = context.normalizeSample(raw);
    expect(normalized.sampledAt).toBe("2026-10-08T12:00:00Z");
    expect(normalized.lastInference?.at).toBe("2026-10-08T10:00:00Z");
    expect(f.store.view(f.node.id, normalized, Date.parse("2026-10-08T12:00:00Z")).cache).toEqual({ idleMinutes: 120, warmEstimate: false });
    expect(context.normalizeSample({ ...raw, transcript_path: undefined }).lastInference?.at).toBeNull();
  });
});

describe("renewal before the shared durable wake", () => {
  it("renews a cold used seat before delivering to the confirmed successor", async () => {
    const f = setup(); await f.item();
    await f.queue.maybeNudge("work-1", "worker@project", true);
    expect(f.handover).toHaveBeenCalledOnce(); expect(f.handover.mock.calls[0][1]).toBe("fresh");
    expect(f.send).toHaveBeenCalledOnce(); expect(f.seat.usage.sessionId).toBe("native-2");
    expect(f.store.view(f.node.id, f.seat.usage).renewal.last.transition).toBe("renewed-before-delivery");
  });
  it.each(["warm", "small", "running", "protected", "unknown", "baseline-missing", "not-ready", "in-progress"])("skips %s without blocking normal delivery", async reason => {
    const f = setup(); await f.item();
    if (reason === "warm") f.seat.usage.lastInference!.at = "2026-10-08T11:30:00Z";
    if (reason === "small") f.baseline(80_000);
    if (reason === "running") f.seat.idle = false;
    if (reason === "protected") f.seat.protected = true;
    if (reason === "unknown") f.seat.usage.availability = "unknown";
    if (reason === "baseline-missing") f.db.prepare("DELETE FROM session_renewal_baselines").run();
    if (reason === "not-ready") f.seat.ready = false;
    if (reason === "in-progress") f.db.prepare("UPDATE queue_items SET state='in-progress' WHERE qitem_id='work-1'").run();
    await f.queue.maybeNudge("work-1", "worker@project", true);
    expect(f.handover).not.toHaveBeenCalled(); expect(f.send).toHaveBeenCalledOnce();
  });
  it("honors strict threshold boundaries", async () => {
    const f = setup(); await f.item(); f.baseline(70_000);
    await f.service.beforeWake("work-1", "worker@project"); expect(f.handover).not.toHaveBeenCalled();
    await f.item("work-2"); f.baseline(20_000); f.seat.usage.lastInference!.at = "2026-10-08T11:00:00Z";
    await f.service.beforeWake("work-2", "worker@project"); expect(f.handover).not.toHaveBeenCalled();
  });
  it("checks all work owned by the chair, not just the incoming item", async () => {
    const f = setup(); await f.item(); await f.item("other-work");
    f.db.prepare("UPDATE queue_items SET state='in-progress' WHERE qitem_id='other-work'").run();
    await f.service.beforeWake("work-1", "worker@project"); expect(f.handover).not.toHaveBeenCalled();
  });
  it("uses rebuild for human continuation", async () => {
    const f = setup(); await f.item(); f.db.prepare("UPDATE queue_items SET human_answers=? WHERE qitem_id='work-1'").run('{"decision":"continue"}');
    await f.service.beforeWake("work-1", "worker@project"); expect(f.handover.mock.calls[0][1]).toBe("rebuild");
  });
  it("does not repeat a replacement across retries, concurrent wakes, or a service restart", async () => {
    const f = setup(); await f.item();
    await Promise.all([f.service.beforeWake("work-1", "worker@project"), f.service.beforeWake("work-1", "worker@project")]);
    await new SessionRenewalService(f.deps).beforeWake("work-1", "worker@project");
    expect(f.handover).toHaveBeenCalledOnce();
  });
  it("re-evaluates the same item for a later human response and rebuilds", async () => {
    const f = setup(); await f.item(); await f.service.beforeWake("work-1", "worker@project"); f.baseline();
    f.db.prepare("UPDATE queue_items SET human_answers=? WHERE qitem_id='work-1'").run('{"decision":"new reply"}');
    await f.service.beforeWake("work-1", "worker@project"); expect(f.handover).toHaveBeenCalledTimes(2);
    expect(f.handover.mock.calls[1][1]).toBe("rebuild");
  });
  it("falls back to a live confirmed predecessor after a failed replacement", async () => {
    const f = setup(); await f.item(); f.handover.mockImplementation(async () => ({ ok: false, detail: "before-replacement" }));
    await f.queue.maybeNudge("work-1", "worker@project", true);
    expect(f.send).toHaveBeenCalledOnce(); expect(f.escalate).not.toHaveBeenCalled();
    expect(f.store.view(f.node.id, f.seat.usage).renewal.last.transition).toBe("renewal-failed");
  });
  it("keeps delivery pending after replacement when no registered occupant is confirmed", async () => {
    const f = setup(); await f.item(); f.verify.mockResolvedValue(null);
    await f.queue.maybeNudge("work-1", "worker@project", true);
    expect(f.send).not.toHaveBeenCalled(); expect(f.escalate).toHaveBeenCalledOnce();
    expect(f.db.prepare("SELECT state FROM queue_items WHERE qitem_id='work-1'").get()).toEqual({ state: "pending" });
    await f.service.beforeWake("work-1", "worker@project"); expect(f.handover).toHaveBeenCalledOnce();
  });
  it("revalidates activity immediately before replacement", async () => {
    const f = setup(); await f.item(); f.handover.mockImplementation(async (_seat, _mode, check) => {
      f.seat.idle = false; return { ok: await check(), detail: "activity_changed" };
    });
    await f.service.beforeWake("work-1", "worker@project");
    expect(f.store.view(f.node.id, f.seat.usage).renewal.last.transition).toBe("renewal-failed");
    expect(f.seat.usage.sessionId).toBe("native-1");
  });
  it("never replays a durable started operation after recovery", async () => {
    const f = setup(); await f.item();
    let entered!: () => void; const ready = new Promise<void>(resolve => { entered = resolve; });
    f.handover.mockImplementation(async () => { entered(); return new Promise(() => {}); });
    void f.service.beforeWake("work-1", "worker@project"); await ready;
    const recovered = new SessionRenewalService({ ...f.deps, exclusive: (_node, fn) => fn() });
    expect(await recovered.beforeWake("work-1", "worker@project")).toEqual({ ok: true, destination: "worker@project" });
    expect(f.handover).toHaveBeenCalledOnce();
    expect(f.store.view(f.node.id, f.seat.usage).renewal.last.detail).toContain("replacement was not repeated");
  });
});

describe("policy and persistent state", () => {
  it("inherits rig policy, supports member override, rejects bad thresholds", () => {
    const f = setup(); expect(f.store.policy(f.node.id)).toEqual({ enabled: true, cacheTtlMinutes: 60, usedTokensMargin: 30_000 });
    f.db.prepare("UPDATE nodes SET session_renewal_json=? WHERE id=?").run('{"enabled":false,"cacheTtlMinutes":120}', f.node.id);
    expect(f.store.policy(f.node.id)).toEqual({ enabled: false, cacheTtlMinutes: 120, usedTokensMargin: 30_000 });
    expect(validateSessionRenewal({ usedTokensMargin: 0 }, "policy")).toHaveLength(1);
    expect(validateSessionRenewal({ enabled: "true" }, "policy")).toHaveLength(1);
  });
  it("round-trips RigSpec and member policies", () => {
    const raw = { version: "0.2", name: "project", session_renewal: { enabled: true }, pods: [{ id: "team", label: "Team",
      members: [{ id: "worker", agent_ref: "local:codex", profile: "default", runtime: "codex", cwd: ".",
        session_renewal: { cacheTtlMinutes: 120 } }] }] };
    const validated = RigSpecSchema.validate(raw); expect(validated.valid, validated.errors.join("; ")).toBe(true);
    if (!validated.valid) return;
    const spec = RigSpecSchema.normalize(raw);
    const decoded = RigSpecCodec.parse(RigSpecCodec.serialize(spec)) as any;
    expect(decoded.session_renewal).toEqual({ enabled: true });
    expect(decoded.pods[0].members[0].session_renewal).toEqual({ cacheTtlMinutes: 120 });
  });
  it("preserves baseline across a database reopen and refuses a different native session", () => {
    const dir = mkdtempSync(join(tmpdir(), "renewal-db-")); cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    const file = join(dir, "test.sqlite"); let db = new Database(file); migrate(db, ALL_MIGRATIONS);
    const rigs = new RigRepository(db), rig = rigs.createRig("project"), node = rigs.addNode(rig.id, "worker");
    db.prepare("INSERT INTO session_renewal_baselines VALUES (?,?,?,?,?)").run(node.id, "codex_token_count_jsonl", "native-1", 20_000, "2026-10-08T09:00:00Z");
    db.close(); db = new Database(file); cleanup.push(() => db.close());
    const store = new SessionRenewalStore(db);
    expect(store.baseline(node.id, usage())).toBe(20_000); expect(store.baseline(node.id, usage({ sessionId: "native-2" }))).toBeNull();
  });
});
