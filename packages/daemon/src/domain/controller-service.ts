import fs from "node:fs";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { RigRepository } from "./rig-repository.js";
import type { Node, NodeInventoryEntry, ControllerStatus } from "./types.js";

const execFileAsync = promisify(execFile);
type Mode = "off" | "observe" | "apply";
type Runner = (executable: string, args: string[], cwd: string) => Promise<unknown>;
export class ControllerServiceError extends Error {
  constructor(public code: string, public status: 400 | 404 | 409 | 503) { super(code); }
}

/** Operator-registered tool only. HTTP callers select a node and an enum, never a program/path. */
export class ControllerService {
  private cache = new Map<string, { at: number; value: ControllerStatus }>();
  private inFlight = new Map<string, Promise<ControllerStatus>>();
  constructor(private repo: RigRepository, private runner: Runner = async (executable, args, cwd) => {
    try {
      const { stdout } = await execFileAsync(executable, args, { cwd, timeout: 10_000, maxBuffer: 64 * 1024, encoding: "utf8" });
      return JSON.parse(stdout);
    } catch (error) {
      try {
        const body = JSON.parse((error as { stdout?: string }).stdout ?? "{}");
        if (body.error === "stale_mode_revision") throw new ControllerServiceError(body.error, 409);
      } catch (parsed) { if (parsed instanceof ControllerServiceError) throw parsed; }
      throw new ControllerServiceError("controller_unavailable", 503);
    }
  }) {}

  private node(rigId: string, nodeId: string): Node {
    const rig = this.repo.getRig(rigId);
    const node = rig?.nodes.find(n => n.id === nodeId);
    if (!node || !node.controller || node.runtime !== "terminal") throw new ControllerServiceError("controller_not_found", 404);
    return node;
  }
  private registration(node: Node): { config: string; entry: string; cwd: string } {
    try {
      const cwd = fs.realpathSync(node.cwd ?? ".");
      const config = fs.realpathSync(path.resolve(cwd, node.controller!.config));
      const relative = path.relative(cwd, config);
      if (path.isAbsolute(relative) || relative === ".." || relative.startsWith(".." + path.sep)) throw Error();
      const packageRoot = path.dirname(config);
      const pkgPath = path.join(packageRoot, "package.json");
      if (fs.statSync(pkgPath).size > 16 * 1024 || fs.statSync(config).size > 64 * 1024) throw Error();
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
      if (!["@openrig-lab/jev-controller", "@dev-core/jev-controller"].includes(pkg.name)
        || pkg.bin?.["jev-flow"] !== "dist/src/cli.js") throw Error();
      const entry = fs.realpathSync(path.join(packageRoot, "dist/src/cli.js"));
      if (!entry.startsWith(packageRoot + path.sep)) throw Error();
      return { config, entry, cwd };
    } catch { throw new ControllerServiceError("controller_registration_unavailable", 503); }
  }
  async status(rigId: string, nodeId: string): Promise<ControllerStatus> {
    const node = this.node(rigId, nodeId);
    const key = node.id + "|" + node.controller!.config;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < 2000) return hit.value;
    const pending = this.inFlight.get(key);
    if (pending) return pending;
    const run = (async () => {
      try {
        const r = this.registration(node);
        const body = await this.runner(process.execPath, [r.entry, "status", "--config", r.config, "--json"], r.cwd) as Record<string, unknown>;
        if (!["off", "observe", "apply"].includes(String(body.mode)) || !Number.isSafeInteger(body.revision)) throw Error();
        const value: ControllerStatus = { ...node.controller!, available: true,
          mode: body.mode as Mode, revision: body.revision as number,
          changedAt: typeof body.changedAt === "string" ? body.changedAt : null,
          model: typeof body.model === "string" ? body.model : undefined,
          modelApplyEnabled: body.modelApplyEnabled === true,
          latest: body.latest as ControllerStatus["latest"] };
        if (body.integration && typeof body.integration === "object") value.integration = body.integration as ControllerStatus["integration"];
        this.cache.set(key, { at: Date.now(), value });
        return value;
      } catch (error) {
        return { ...node.controller!, available: false, error: error instanceof ControllerServiceError ? error.code : "controller_status_invalid" };
      }
    })();
    this.inFlight.set(key, run);
    try { return await run; } finally { this.inFlight.delete(key); }
  }
  /** Read-only terminal monitor of the same registered controller. No HTTP-supplied command. */
  monitorCommand(rigId: string, nodeId: string): string {
    const r = this.registration(this.node(rigId, nodeId));
    const quote = (value: string): string => "'" + value.replace(/'/g, "'\"'\"'") + "'";
    return ["env NODE_NO_WARNINGS=1", quote(process.execPath), quote(r.entry), "watch", "--config", quote(r.config)].join(" ");
  }
  async setMode(rigId: string, nodeId: string, mode: Mode, expectedRevision?: number): Promise<ControllerStatus> {
    if (!["off", "observe", "apply"].includes(mode) || (expectedRevision !== undefined && (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0)))
      throw new ControllerServiceError("invalid_controller_mode", 400);
    const node = this.node(rigId, nodeId), r = this.registration(node);
    await this.runner(process.execPath, [r.entry, "mode", "--config", r.config, "--set", mode, "--json",
      ...(expectedRevision === undefined ? [] : ["--expected-revision", String(expectedRevision)])], r.cwd);
    this.cache.delete(node.id + "|" + node.controller!.config);
    const pending = this.inFlight.get(node.id + "|" + node.controller!.config);
    if (pending) await pending;
    this.cache.delete(node.id + "|" + node.controller!.config);
    return this.status(rigId, nodeId);
  }
  async enrich(entries: NodeInventoryEntry[]): Promise<NodeInventoryEntry[]> {
    return Promise.all(entries.map(async n => n.controller
      ? { ...n, controller: await this.status(n.rigId, n.nodeId) } : n));
  }
}
