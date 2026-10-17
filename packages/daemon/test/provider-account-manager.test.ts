import { afterEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { SessionRegistry } from "../src/domain/session-registry.js";
import { SeatAccountHomes } from "../src/domain/provider/seat-account-homes.js";
import { ProviderAccountManager } from "../src/domain/provider/provider-account-manager.js";
import { validateHumanRoute } from "../src/domain/human-route-enforcer.js";

const native = vi.hoisted(() => ({ processes: new Map<number, any>(), copied: vi.fn(), read: vi.fn(), probe: vi.fn() }));
vi.mock("../src/domain/provider/native-account-session.js", async importOriginal => ({
  ...await importOriginal<any>(),
  nativeProcess: (pid: number) => native.processes.get(pid) ?? null,
  sameNativeProcess: (proc: any) => [...native.processes.values()].some(p => p?.pid === proc.pid),
  stageConversation: native.copied,
  nativeConversationConfirmed: (proc: any, _runtime: string, id: string) => proc.args.includes(id),
}));
vi.mock("../src/domain/provider/native-account-probe.js", async importOriginal => ({
  ...await importOriginal<any>(), codexRead: native.read, probeAccount: native.probe,
}));
const cleanup: Array<() => void> = [];
afterEach(() => { vi.restoreAllMocks(); cleanup.splice(0).reverse().forEach(f => f()); native.processes.clear(); vi.clearAllMocks(); });
const nativeId = "01a121ad-f543-7f70-802d-d1b26efdb78a";
function fixture() {
  const root = mkdtempSync(path.join(tmpdir(), "account-manager-")); cleanup.push(() => rmSync(root, { recursive: true, force: true }));
  const homes = new SeatAccountHomes(root);
  for (const ref of ["codex-c", "codex-d", "codex-e", "codex-f"]) {
    mkdirSync(path.join(root, ref)); writeFileSync(path.join(root, ref, "auth.json"), JSON.stringify({ tokens: { account_id: ref } }));
  }
  writeFileSync(path.join(root, "seats.conf"), "build-worker@agency-sites=codex-e\nplan-worker@agency-sites=codex-c\n");
  const db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); cleanup.push(() => db.close());
  const rigRepo = new RigRepository(db), sessionRegistry = new SessionRegistry(db), rig = rigRepo.createRig("agency-sites");
  const seats = ["build-worker", "plan-worker"].map((logical, index) => {
    const node = rigRepo.addNode(rig.id, logical, { runtime: "codex", cwd: root });
    const session = `${logical}@agency-sites`, pane = `%${index + 1}`, panePid = index + 100;
    sessionRegistry.registerClaimedSession(node.id, session);
    sessionRegistry.updateBinding(node.id, { tmuxSession: session, tmuxPane: pane });
    db.prepare("UPDATE sessions SET resume_token=? WHERE node_id=?").run(nativeId, node.id);
    const generation = sessionRegistry.currentOccupantTenure(node.id)!.generationUuid;
    native.processes.set(panePid, { pid: panePid + 1000, start: "1", image: "/native/codex", executable: "/native/codex", args: ["--no-daemon", "-s", "workspace-write"],
      home: path.join(root, "codex-d"), nodeId: node.id, session, generation, cwd: root });
    return { node, session, pane, panePid, generation };
  });
  let busy = false, compact = false, protectedSeat = false, respawnFails = false;
  const signal = vi.spyOn(process, "kill").mockImplementation((pid: number) => {
    for (const [key, proc] of native.processes) if (proc.pid === pid) native.processes.delete(key);
    return true;
  });
  const respawn = vi.fn(async (target: string, command: string, opts: any) => {
    if (respawnFails) return { ok: false };
    const seat = seats.find(s => s.node.id === target)!; // guarded writes address the node, not the recycled pane
    native.processes.set(seat.panePid, { pid: seat.panePid + 2000, start: "2", image: "/native/codex", executable: "/native/codex", args: ["resume", nativeId],
      home: opts.env.CODEX_HOME, nodeId: seat.node.id, session: seat.session, generation: seat.generation, cwd: root });
    return { ok: true };
  });
  const guard = { preference: () => ({ desired: protectedSeat, effective: protectedSeat }), lifecycle: async (_nodes: string[], fn: () => any) => fn() };
  const notify = vi.fn(async (input: any) => {
    const validation = validateHumanRoute(input);
    if (!validation.ok) throw new Error(validation.message);
    return {};
  }), send = vi.fn(async () => ({ ok: true, outcome: "delivered" }));
  const deps = { rigRepo, sessionRegistry, queueRepo: { create: notify }, sessionTransport: { send },
    tmuxAdapter: { deliveryGuard: guard, getPanePid: async (pane: string) => seats.find(s => s.pane === pane)?.panePid,
      capturePaneScreen: async () => busy ? "Working\nesc to interrupt" : "Codex\n› ",
      setRemainOnExit: async () => ({ ok: true }), isPaneDead: async (pane: string) => !native.processes.has(seats.find(s => s.pane === pane)!.panePid),
      signalPaneProcess: async () => ({ ok: true }), respawnPane: respawn },
    compactionEnforcer: { hasPendingLifecycle: () => compact },
    agentActivityStore: { getLatestForNode: () => ({ state: busy ? "running" : "idle" }) },
  };
  native.probe.mockResolvedValue({ authenticated: true, identity: "identity", exhausted: false, resetAt: null, quotaKnown: true });
  native.read.mockResolvedValue({ thread: { id: nativeId } });
  const manager = new ProviderAccountManager(deps as any, homes);
  return { db, homes, seats, manager, signal, respawn, notify, send, restart: () => new ProviderAccountManager(deps as any, homes), setBusy: (v: boolean) => busy = v, setCompact: (v: boolean) => compact = v,
    setProtected: (v: boolean) => protectedSeat = v, setRespawnFails: (v: boolean) => respawnFails = v };
}
describe("provider lifecycle and reserve integration", () => {
  it("refuses cutover when input arrives during the native account probe", async () => {
    const f = fixture();
    native.probe.mockImplementationOnce(async () => {
      f.setBusy(true);
      return { authenticated: true, identity: "identity", exhausted: false, resetAt: null, quotaKnown: true };
    });
    expect((await f.manager.switchAccount({ seat: f.seats[0]!.session, toAccount: "codex-e", forceUnsafe: false })).outcome).toBe("failed_safely");
    expect(f.signal).not.toHaveBeenCalled();
  });
  it("persists a deferred repair across daemon restart and waits without stopping a busy recipient", async () => {
    const f = fixture(), seat = f.seats[0]!;
    f.setBusy(true);
    expect(await f.manager.switchAccount({ seat: seat.session, toAccount: "codex-e", forceUnsafe: false, whenIdle: true })).toEqual({ outcome: "rebind_in_progress" });
    const restarted = f.restart();
    await restarted.tick();
    expect(f.signal).not.toHaveBeenCalled();
    expect(await restarted.beforeWake("work", seat.session)).toEqual({ ok: false, reason: "provider_account_switch_pending" });
    f.setBusy(false);
    await restarted.tick();
    expect((f.db.prepare("SELECT state FROM provider_account_repairs").get() as any).state).toBe("completed");
    expect(f.signal).toHaveBeenCalledTimes(1);
    expect(f.respawn.mock.calls[0]![1]).toContain(nativeId);
  });
  it("cancels deferred repairs when their native conversation changes", async () => {
    const f = fixture();
    await f.manager.switchAccount({ seat: f.seats[0]!.session, toAccount: "codex-e", forceUnsafe: false, whenIdle: true });
    f.db.prepare("UPDATE sessions SET resume_token=?").run("01a121ad-f543-7f70-802d-d1b26efdb78b");
    await f.manager.tick();
    expect((f.db.prepare("SELECT state FROM provider_account_repairs").get() as any).state).toBe("stale");
    expect(f.signal).not.toHaveBeenCalled();
  });
  it("notifies once without a free reserve, preserves work, then resumes once after a verified reset", async () => {
    const f = fixture(), seat = f.seats[0]!;
    writeFileSync(path.join(f.homes.root, "seats.conf"), "build-worker@agency-sites=codex-e\nplan-worker@agency-sites=codex-c\nreserved@other-rig=codex-f\n");
    const reset = new Date(Date.now() + 60_000).toISOString();
    native.probe.mockResolvedValue({ authenticated: true, identity: "identity", exhausted: true, resetAt: reset, quotaKnown: true });
    await f.manager.tick(); await f.manager.tick();
    expect(f.notify).toHaveBeenCalledTimes(2); // One notification per affected seat.
    expect(f.send).not.toHaveBeenCalled(); expect(f.signal).not.toHaveBeenCalled();
    expect(await f.manager.beforeWake("work", seat.session)).toEqual({ ok: false, reason: "provider_quota_waiting" });
    f.db.prepare("UPDATE provider_quota_incidents SET reset_at=?").run(new Date(Date.now() - 1000).toISOString());
    native.probe.mockResolvedValue({ authenticated: true, identity: "identity", exhausted: false, resetAt: null, quotaKnown: true });
    await f.manager.tick();
    expect(f.send).toHaveBeenCalledTimes(2);
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM provider_quota_incidents WHERE state='resumed'").get() as any).n).toBe(2);
    expect(f.signal).not.toHaveBeenCalled();
  });
  it("refuses busy, protected or compacting seats before any native process is stopped, even with forceUnsafe", async () => {
    const f = fixture();
    for (const toggle of [f.setBusy, f.setCompact, f.setProtected]) {
      toggle(true);
      expect((await f.manager.switchAccount({ seat: f.seats[0]!.session, toAccount: "codex-e", forceUnsafe: true })).outcome).toBe("failed_safely");
      toggle(false);
    }
    expect(f.signal).not.toHaveBeenCalled(); expect(f.respawn).not.toHaveBeenCalled();
  });
  it("resumes the exact native conversation and persists its account/cache epoch without changing the principal", async () => {
    const f = fixture();
    const result = await f.manager.switchAccount({ seat: f.seats[0]!.session, toAccount: "codex-e", forceUnsafe: false });
    expect(result.outcome).toBe("succeeded");
    expect(f.respawn.mock.calls[0]![1]).toContain(nativeId);
    expect(f.respawn.mock.calls[0]![1]).not.toContain("--fresh");
    const row = f.db.prepare("SELECT * FROM provider_account_bindings").get() as any;
    expect(row.native_session).toBe(nativeId); expect(row.account_ref).toBe("codex-e"); expect(row.generation).toBe(f.seats[0]!.generation);
    expect(f.homes.mappings().get(f.seats[0]!.session)).toBe("codex-e");
  });
  it("does not allocate the same free reserve to two simultaneous automatic switches", async () => {
    const f = fixture();
    const results = await Promise.all(f.seats.map(s => f.manager.switchAccount({ seat: s.session, toAccount: "codex-f", forceUnsafe: false, automatic: true })));
    expect(results.map(r => r.outcome)).toEqual(["succeeded", "failed_safely"]);
    expect(f.signal).toHaveBeenCalledTimes(1);
  });
  it("never takes another seat's principal as a reserve and leaves a failed replacement visible", async () => {
    const f = fixture();
    expect((await f.manager.switchAccount({ seat: f.seats[0]!.session, toAccount: "codex-c", forceUnsafe: false, automatic: true })).outcome).toBe("failed_safely");
    expect(f.signal).not.toHaveBeenCalled();
    f.setRespawnFails(true);
    expect((await f.manager.switchAccount({ seat: f.seats[0]!.session, toAccount: "codex-e", forceUnsafe: false })).outcome).toBe("failed_safely");
    expect((f.db.prepare("SELECT state FROM provider_account_operations").get() as any).state).toBe("recovery_required");
    expect(await f.manager.beforeWake("task", f.seats[0]!.session)).toEqual({ ok: false, reason: "provider_account_recovery_pending" });
    expect((f.db.prepare("SELECT COUNT(*) AS n FROM provider_account_bindings").get() as any).n).toBe(0);
  });
});
