import { afterEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { SeatActivityService } from "../src/domain/seat-activity-service.js";
import { runtimeRungInventory, type ActivityValue } from "../src/domain/activity-taxonomy.js";

const dbs: Database.Database[] = [];
afterEach(() => { for (const db of dbs) db.close(); dbs.length = 0; });

function fixture() {
  const db = createDb();
  dbs.push(db);
  migrate(db, ALL_MIGRATIONS);
  let milliseconds = Date.parse("2026-10-08T10:00:00Z");
  let generation: string | null = "generation-1";
  const now = () => new Date(milliseconds);
  const service = (sessionName = "worker@fixture") => {
    const result = new SeatActivityService({ db, tmux: { readPaneLastActivity: async () => null },
      defaultWindowSeconds: 3, now, resolveOccupantGeneration: () => generation });
    result.declareRungInventory({ seatNodeId: "node-1", sessionName }, runtimeRungInventory("claude-code"));
    return result;
  };
  const evidence = (svc: SeatActivityService, activity: ActivityValue, seq = 1, sessionName = "worker@fixture") => {
    svc.reportEvidence({ seatNodeId: "node-1", sessionName, sourceId: "native-self-report",
      rung: "self-report", seq, observedAt: now().toISOString(), activity });
  };
  return { db, service, evidence, now, advance: (ms: number) => { milliseconds += ms; },
    generation: (value: string | null) => { generation = value; } };
}

describe("seat activity timing", () => {
  it("keeps activity time stable across input reasons, source changes and repeated observations", () => {
    const f = fixture();
    const svc = f.service();
    f.evidence(svc, "idle-at-prompt");
    const first = svc.getSeatState("node-1")!.activityStartedAt;
    f.advance(5000);
    svc.reportEvidence({ seatNodeId: "node-1", sessionName: "worker@fixture", rung: "needs-input-chrome",
      sourceId: "chrome", seq: 1, observedAt: f.now().toISOString(), needsInput: { count: 1, reason: "permission" } });
    expect(svc.getSeatState("node-1")!.changedAt).not.toBe(first);
    expect(svc.getSeatState("node-1")!.activityStartedAt).toBe(first);
    f.advance(5000);
    f.evidence(svc, "idle-at-prompt", 2);
    svc.reportEvidence({ seatNodeId: "node-1", sessionName: "worker@fixture", rung: "self-report",
      sourceId: "replacement-native-source", seq: 1, observedAt: f.now().toISOString(), activity: "idle-at-prompt" });
    expect(svc.getSeatState("node-1")!.activityStartedAt).toBe(first);
    f.evidence(svc, "working", 3);
    expect(svc.getSeatState("node-1")!.activityStartedAt).toBe(f.now().toISOString());
  });

  it("restores the same verified generation only after a fresh matching observation", () => {
    const f = fixture();
    const first = f.service();
    f.evidence(first, "idle-at-prompt");
    const original = first.getSeatState("node-1")!.activityStartedAt;
    f.advance(60000);
    const restarted = f.service();
    expect(restarted.getSeatState("node-1")!.activity).toBe("unknown");
    expect(restarted.getSeatState("node-1")!.activityStartedAt).toBe(f.now().toISOString());
    expect(f.db.prepare("SELECT activity_started_at FROM seat_activity_timing").get()).toEqual({ activity_started_at: original });
    f.evidence(restarted, "idle-at-prompt");
    expect(restarted.getSeatState("node-1")!.activityStartedAt).toBe(original);
    expect(restarted.getSeatState("node-1")!.decidedBy).toBe("self-report");
  });

  it("starts a new duration when fresh activity or session differs from the durable row", () => {
    const f = fixture();
    const first = f.service();
    f.evidence(first, "idle-at-prompt");
    f.advance(60000);
    const restarted = f.service();
    f.evidence(restarted, "working");
    expect(restarted.getSeatState("node-1")!.activityStartedAt).toBe(f.now().toISOString());
    f.advance(60000);
    const renamed = f.service("renamed@fixture");
    f.evidence(renamed, "working", 1, "renamed@fixture");
    expect(renamed.getSeatState("node-1")!.activityStartedAt).toBe(f.now().toISOString());
    expect(f.db.prepare("SELECT session_name FROM seat_activity_timing").get()).toEqual({ session_name: "renamed@fixture" });
  });

  it("rejects prior generations and removes timing on explicit swaps before another seat observation", () => {
    const f = fixture();
    const first = f.service();
    f.evidence(first, "idle-at-prompt");
    f.advance(60000);
    f.generation("generation-2");
    const restarted = f.service();
    f.evidence(restarted, "idle-at-prompt");
    expect(restarted.getSeatState("node-1")!.activityStartedAt).toBe(f.now().toISOString());
    expect(f.db.prepare("SELECT generation FROM seat_activity_timing").get()).toEqual({ generation: "generation-2" });
    f.advance(1000);
    f.generation("generation-3");
    restarted.declareOccupantSwap("node-1", "generation-3");
    expect(restarted.getSeatState("node-1")!.activityStartedAt).toBe(f.now().toISOString());
    expect(restarted.getSeatState("node-1")!.activity).toBe("unknown");
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM seat_activity_timing").get()).toEqual({ count: 0 });
  });

  it("does not persist an unverified generation or accept a future durable timestamp", () => {
    const f = fixture();
    f.generation(null);
    const unverified = f.service();
    f.evidence(unverified, "idle-at-prompt");
    expect(f.db.prepare("SELECT COUNT(*) AS count FROM seat_activity_timing").get()).toEqual({ count: 0 });
    f.generation("generation-1");
    const future = new Date(f.now().getTime() + 60000).toISOString();
    f.db.prepare("INSERT INTO seat_activity_timing VALUES ('node-1','generation-1','worker@fixture','idle-at-prompt',?,?)").run(future, future);
    const verified = f.service();
    f.evidence(verified, "idle-at-prompt");
    expect(verified.getSeatState("node-1")!.activityStartedAt).toBe(f.now().toISOString());
  });
});
