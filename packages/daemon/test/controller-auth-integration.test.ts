import { afterEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { networkWriteAuth } from "../src/middleware/network-write-auth.js";
import { controllerRoutes } from "../src/routes/controllers.js";
import { projectHumans, projectionPath } from "../src/domain/gateway/human-registry.js";

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => fs.rmSync(root, { recursive: true, force: true })));
function fixture(peer = "100.114.220.73") {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "controller-auth-")); roots.push(home);
  const humans = path.join(home, "gateway/humans"), bridges = path.join(home, "gateway/bridges");
  fs.mkdirSync(humans, { recursive: true }); fs.mkdirSync(bridges, { recursive: true });
  fs.writeFileSync(path.join(humans, "operator.yaml"), JSON.stringify({ entityId: "operator", class: "human", displayName: "Operator",
    address: "operator@external", connectorBindings: [{ kind: "hermes", connectorRef: "hermes-fixture", secretsRef: "fixture", role: "primary", handle: "telegram-42" }], prefs: { deliveryClass: "A" } }));
  const projected = projectHumans(home);
  if (!projected.ok) throw new Error(projected.error);
  fs.writeFileSync(projectionPath(home), projected.body);
  fs.writeFileSync(path.join(bridges, "hermes-fixture.json"), JSON.stringify({ id: "hermes-fixture", enabled: true,
    humanAddress: "operator@external", legacyAliases: ["human@kernel"], tokenSha256: createHash("sha256").update("bridge-fixture").digest("hex"),
    scopes: ["inbox", "receipts", "answer", "create"], allowedDestinations: ["lab-executor@lab"], origins: {} }));
  const status = { kind: "jev-flow", config: "/fixture/policy.json", mode: "observe", available: true, revision: 4 };
  const service = { status: vi.fn(async () => status), setMode: vi.fn(async (_rig: string, _node: string, mode: string) => ({ ...status, mode, revision: 5 })) };
  const app = new Hono(); app.use("*", networkWriteAuth({ home, operatorTokens: ["operator-fixture"], terminalToken: "terminal-fixture", activityHookToken: "hook-fixture", peerAddress: () => peer }));
  app.use("*", async (c, next) => { c.set("controllerService" as never, service as never); await next(); });
  app.route("/api/rigs/:rigId/controllers", controllerRoutes);
  const request = (token?: string, method = "PATCH") => app.request("/api/rigs/lab/controllers/tool", { method,
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    ...(method === "PATCH" ? { body: JSON.stringify({ mode: "off", expectedRevision: 4 }) } : {}) });
  return { service, request };
}

describe("controller authorization through native middleware", () => {
  it("remote writes admit only operator credentials, preserving scoped Hermes isolation", async () => {
    const f = fixture();
    for (const token of [undefined, "unknown-fixture", "terminal-fixture", "hook-fixture"])
      expect((await f.request(token)).status).toBe(401);
    expect((await f.request("bridge-fixture")).status).toBe(403);
    expect(f.service.setMode).not.toHaveBeenCalled();
    const response = await f.request("operator-fixture");
    expect(response.status).toBe(200); expect(await response.json()).toMatchObject({ mode: "off", revision: 5 });
    expect(f.service.setMode).toHaveBeenCalledWith("lab", "tool", "off", 4);
  });

  it("bridge tokens cannot read or change controller state even over loopback", async () => {
    const f = fixture("127.0.0.1");
    expect((await f.request("bridge-fixture", "GET")).status).toBe(403);
    expect((await f.request("bridge-fixture")).status).toBe(403);
    expect(f.service.status).not.toHaveBeenCalled(); expect(f.service.setMode).not.toHaveBeenCalled();
    expect((await f.request()).status).toBe(200);
  });
});
