import { describe, it, expect, afterEach } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Hono } from "hono";
import { ControllerService } from "../src/domain/controller-service.js";
import { controllerRoutes } from "../src/routes/controllers.js";
import type { RigRepository } from "../src/domain/rig-repository.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), "openrig-controller-")); roots.push(cwd);
  const root = path.join(cwd, "jev"); fs.mkdirSync(path.join(root, "dist/src"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@openrig-lab/jev-controller", bin: { "jev-flow": "dist/src/cli.js" } }));
  fs.writeFileSync(path.join(root, "policy.json"), "{}"); fs.writeFileSync(path.join(root, "dist/src/cli.js"), "// fixture");
  const node = { id: "tool", cwd, runtime: "terminal", controller: { kind: "jev-flow", config: "jev/policy.json" } };
  const repo = { getRig: (id: string) => id === "rig" ? { nodes: [node] } : null } as unknown as RigRepository;
  const calls: string[][] = []; let mode = "observe", revision = 0;
  const service = new ControllerService(repo, async (executable, args, calledCwd) => {
    expect(executable).toBe(process.execPath); expect(calledCwd).toBe(cwd); calls.push(args);
    if (args[1] === "mode") { mode = args[args.indexOf("--set") + 1]!; revision++; }
    return { mode, revision, modelApplyEnabled: false, integration: { worker: "running", keyAvailable: true, counts: { pending: 2 } } };
  });
  const app = new Hono(); app.use("*", async (c, next) => { c.set("controllerService" as never, service as never); await next(); });
  app.route("/api/rigs/:rigId/controllers", controllerRoutes);
  return { cwd, root, node, calls, service, app };
}
describe("registered controller", () => {
  it("admits the independent dev-core package and refuses arbitrary packages", async () => {
    const f=fixture();
    fs.writeFileSync(path.join(f.root,"package.json"),JSON.stringify({name:"@dev-core/jev-controller",bin:{"jev-flow":"dist/src/cli.js"}}));
    expect((await f.service.status("rig","tool")).available).toBe(true);
    const other=fixture();fs.writeFileSync(path.join(other.root,"package.json"),JSON.stringify({name:"unregistered",bin:{"jev-flow":"dist/src/cli.js"}}));
    expect((await other.service.status("rig","tool")).available).toBe(false);
  });
  it("terminal monitor uses only the registered entry, quoted argv and read-only watch", () => {
    const f = fixture();
    const command = f.service.monitorCommand("rig", "tool");
    expect(command).toContain("'" + process.execPath + "'");
    expect(command).toContain("'" + path.join(f.root, "dist/src/cli.js") + "' watch --config");
    expect(f.calls).toHaveLength(0);
    expect(() => f.service.monitorCommand("other", "tool")).toThrow("controller_not_found");
    fs.unlinkSync(path.join(f.root, "dist/src/cli.js"));
    fs.symlinkSync(path.join(f.cwd, "outside.js"), path.join(f.root, "dist/src/cli.js"));
    expect(() => f.service.monitorCommand("rig", "tool")).toThrow("controller_registration_unavailable");
  });
  it("status coalesces reads; mode uses fixed argv and refreshes projection", async () => {
    const f = fixture(); const [a,b] = await Promise.all([f.service.status("rig", "tool"), f.service.status("rig", "tool")]);
    expect(a.mode).toBe("observe"); expect(b).toEqual(a); expect(f.calls).toHaveLength(1);
    expect(a.integration).toMatchObject({ worker: "running", keyAvailable: true, counts: { pending: 2 } });
    const result = await f.service.setMode("rig", "tool", "off", 0);
    expect(result.mode).toBe("off"); expect(result.revision).toBe(1);
    expect(f.calls[1]).toEqual([path.join(f.root, "dist/src/cli.js"), "mode", "--config", path.join(f.root,"policy.json"), "--set", "off", "--json", "--expected-revision", "0"]);
  });
  it("rejects arbitrary commands, paths, revisions and unrelated nodes before execution", async () => {
    const f = fixture();
    for (const body of [{mode:"sh"},{mode:"apply",config:"/tmp/other"},{mode:"off",expectedRevision:-1},[]]) {
      const r = await f.app.request("/api/rigs/rig/controllers/tool", { method:"PATCH", headers:{"Content-Type":"application/json"},body:JSON.stringify(body) });
      expect(r.status).toBe(400);
    }
    expect((await f.app.request("/api/rigs/other/controllers/tool")).status).toBe(404);
    expect(f.calls).toHaveLength(0);
  });
  it("refuses executable symlinks escaping the registered package", async () => {
    const f = fixture(); const outside=path.join(f.cwd,"outside.js"); fs.writeFileSync(outside,"// external");
    fs.unlinkSync(path.join(f.root,"dist/src/cli.js")); fs.symlinkSync(outside,path.join(f.root,"dist/src/cli.js"));
    expect((await f.service.status("rig","tool")).available).toBe(false); expect(f.calls).toHaveLength(0);
  });
  it("HTTP returns the native status shape used by web and TUI", async () => {
    const f=fixture();const response=await f.app.request("/api/rigs/rig/controllers/tool",{method:"PATCH",headers:{"Content-Type":"application/json"},body:JSON.stringify({mode:"observe",expectedRevision:0})});
    expect(response.status).toBe(200);expect(await response.json()).toMatchObject({kind:"jev-flow",mode:"observe",available:true,revision:1});
  });
});
