import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFullTestDb, createTestApp } from "./helpers/test-app.js";
import { migrate } from "../src/db/migrate.js";
import { controllerTelemetryCompactionSchema } from "../src/db/migrations/097_controller_telemetry_compaction.js";
import { PodRepository } from "../src/domain/pod-repository.js";
import { RigSpecSchema } from "../src/domain/rigspec-schema.js";
import { RigSpecCodec } from "../src/domain/rigspec-codec.js";
import { RigSpecExporter } from "../src/domain/rigspec-exporter.js";
import type { RigSpec } from "../src/domain/types.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0).reverse()) close(); });
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "controller-binding-"));
  cleanup.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const db = createFullTestDb(); cleanup.push(() => db.close());
  migrate(db, [controllerTelemetryCompactionSchema]);
  const setup = createTestApp(db, { podInstantiatorFsOps: { exists: fs.existsSync, readFile: p => fs.readFileSync(p, "utf8") } });
  const rig = setup.rigRepo.createRig("lab");
  const pod = new PodRepository(db).createPod(rig.id, "lab", "Laboratory");
  const prior = setup.rigRepo.addNode(rig.id, "lab.executor", { runtime: "codex", podId: pod.id, cwd: root, agentRef: "local:agents/executor", profile: "default" });
  const member = { id: "jev", runtime: "terminal", agent_ref: "builtin:terminal", profile: "none", cwd: root,
    controller: { kind: "jev-flow", config: "tools/jev/policy.json" } };
  return { ...setup, root, rig, prior, member };
}

describe("controller binding through native topology", () => {
  it("schema and codec preserve a binding and reject agent attachment", () => {
    const f = fixture();
    const raw = { version: "0.2", name: "fixture", pods: [{ id: "lab", label: "Lab", members: [f.member], edges: [] }], edges: [] };
    expect(RigSpecSchema.validate(raw).errors).toEqual([]);
    const normalized = RigSpecSchema.normalize(raw);
    const roundtrip = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(normalized)));
    expect(roundtrip.pods[0]!.members[0]!.controller).toEqual(f.member.controller);
    const agent = { ...raw, pods: [{ ...raw.pods[0]!, members: [{ ...f.member, runtime: "codex", agent_ref: "local:agents/executor", profile: "default" }] }] };
    expect(RigSpecSchema.validate(agent).errors.join(" ")).toContain("controller");
  });

  it("POST add_member persists, projects and exports the controller without relaunching peers", async () => {
    const f = fixture(); const launch = vi.spyOn(f.nodeLauncher, "launchNode");
    const response = await f.app.request(`/api/rigs/${f.rig.id}/pods/lab/members`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigRoot: f.root, member: f.member, edges: [{ from: "jev", to: "executor", kind: "can_observe" }] }) });
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(201);
    const nodes = f.rigRepo.getRig(f.rig.id)!.nodes;
    const tool = nodes.find(node => node.logicalId === "lab.jev")!;
    expect(tool.controller).toEqual({ kind: "jev-flow", config: path.join(f.root, "tools/jev/policy.json") });
    expect(nodes.find(node => node.id === f.prior.id)).toMatchObject({ logicalId: "lab.executor", runtime: "codex" });
    expect(launch).toHaveBeenCalledTimes(1); expect(launch.mock.calls[0]![1]).toBe("lab.jev");
    const graph = await (await f.app.request(`/api/rigs/${f.rig.id}/graph`)).json();
    expect(graph.nodes.find((node: { id: string }) => node.id === tool.id).data).toMatchObject({ nodeKind: "infrastructure", controller: tool.controller });
    const exported = new RigSpecExporter({ rigRepo: f.rigRepo, sessionRegistry: f.sessionRegistry, podRepo: new PodRepository(f.db) }).exportRig(f.rig.id) as RigSpec;
    expect(exported.pods[0]!.members.find(member => member.id === "jev")!.controller).toEqual(tool.controller);
    const restored = RigSpecSchema.normalize(RigSpecCodec.parse(RigSpecCodec.serialize(exported)));
    expect(restored.pods[0]!.members.find(member => member.id === "jev")!.controller).toEqual(tool.controller);
  });

  it("POST expand keeps the controller through both fragment normalizers", async () => {
    const f = fixture();
    const response = await f.app.request(`/api/rigs/${f.rig.id}/expand`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ rigRoot: f.root, pod: { id: "tools", label: "Tools", members: [f.member], edges: [] } }) });
    const body = await response.json(); expect(response.status, JSON.stringify(body)).toBe(201);
    expect(f.rigRepo.getRig(f.rig.id)!.nodes.find(node => node.logicalId === "tools.jev")!.controller)
      .toEqual({ kind: "jev-flow", config: path.join(f.root, "tools/jev/policy.json") });
  });
});
