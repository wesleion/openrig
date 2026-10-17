import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import Database from "better-sqlite3";
import { readFile } from "node:fs/promises";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { RigRepository } from "../src/domain/rig-repository.js";
import { confirmRenewalRecipient } from "../src/domain/session-renewal-recipient.js";
import { verifyClaudePaneRuntime, verifyCodexPaneProcess } from "../src/domain/native-process-lineage.js";

vi.mock("node:fs/promises", () => ({ readFile: vi.fn() }));
vi.mock("../src/domain/native-process-lineage.js", () => ({ verifyClaudePaneRuntime: vi.fn(), verifyCodexPaneProcess: vi.fn() }));
let db: Database.Database;
beforeEach(() => { vi.clearAllMocks(); db = new Database(":memory:"); migrate(db, ALL_MIGRATIONS); });
afterEach(() => db.close());

function fixture(runtime = "codex") {
  const repo = new RigRepository(db), rig = repo.createRig("project"), node = repo.addNode(rig.id, "worker", { runtime });
  db.prepare("INSERT INTO sessions(id,node_id,session_name,status,startup_status) VALUES (?,?,?,?,?)")
    .run("session", node.id, "worker@project", "running", "ready");
  const native = { panePid: 100, fingerprint: "native-pid-101-start", process: { pid: 101 } };
  vi.mocked(verifyClaudePaneRuntime).mockResolvedValue(native as any);
  vi.mocked(verifyCodexPaneProcess).mockResolvedValue(native as any);
  vi.mocked(readFile).mockResolvedValue(`OPENRIG_NODE_ID=${node.id}\0OPENRIG_SESSION_NAME=worker@project\0OPENRIG_OCCUPANT_GENERATION=g1\0`);
  const deps = { rigRepo: repo, sessionRegistry: { currentOccupantTenure: () => ({ generationUuid: "g1" }) },
    tmuxAdapter: { getPanePid: async () => 100,
      deliveryGuard: { target: () => ({ nodeId: node.id, session: "worker@project", occupant: "g1", pane: "%1" }) } } } as unknown as Parameters<typeof confirmRenewalRecipient>[0];
  return { deps, node, native };
}

describe("post-renewal recipient proof", () => {
  it.each(["claude-code", "codex"])("accepts a live %s only with matching carried identities", async runtime => {
    const f = fixture(runtime);
    expect(await confirmRenewalRecipient(f.deps, f.node.id)).toBe("worker@project");
    const observer = runtime === "codex" ? verifyCodexPaneProcess : verifyClaudePaneRuntime;
    expect(observer).toHaveBeenCalledTimes(2);
  });
  it("rejects a replacement that started before the old registry binding committed", async () => {
    const f = fixture();
    vi.mocked(readFile).mockResolvedValue(`OPENRIG_NODE_ID=${f.node.id}\0OPENRIG_SESSION_NAME=worker@project\0OPENRIG_OCCUPANT_GENERATION=g2\0`);
    expect(await confirmRenewalRecipient(f.deps, f.node.id)).toBeNull();
  });
  it("rejects a process that disappears or changes during verification", async () => {
    const f = fixture(); vi.mocked(verifyCodexPaneProcess).mockResolvedValueOnce(f.native as any).mockResolvedValueOnce(null);
    expect(await confirmRenewalRecipient(f.deps, f.node.id)).toBeNull();
    vi.mocked(verifyCodexPaneProcess).mockResolvedValueOnce(f.native as any)
      .mockResolvedValueOnce({ ...f.native, fingerprint: "different-process" } as any);
    expect(await confirmRenewalRecipient(f.deps, f.node.id)).toBeNull();
  });
  it("refuses missing identity evidence and a seat that has not completed startup", async () => {
    const f = fixture(); vi.mocked(readFile).mockResolvedValue("UNRELATED=value\0");
    expect(await confirmRenewalRecipient(f.deps, f.node.id)).toBeNull();
    db.prepare("UPDATE sessions SET startup_status='pending'").run();
    expect(await confirmRenewalRecipient(f.deps, f.node.id)).toBeNull();
  });
});
