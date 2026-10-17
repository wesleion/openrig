import type { AppDeps } from "../server.js";
import { readFile } from "node:fs/promises";
import { verifyClaudePaneRuntime, verifyCodexPaneProcess } from "./native-process-lineage.js";

/** A registry binding alone is insufficient after a failed in-place replacement. */
export async function confirmRenewalRecipient(
  deps: Pick<AppDeps, "rigRepo" | "sessionRegistry" | "tmuxAdapter">, nodeId: string,
): Promise<string | null> {
  try {
    const { sessionRegistry, tmuxAdapter } = deps;
    const guard = tmuxAdapter.deliveryGuard;
    if (!guard) return null;
    const current = deps.rigRepo.db.prepare(`SELECT s.session_name,s.startup_status,n.runtime
      FROM sessions s JOIN nodes n ON n.id=s.node_id WHERE s.node_id=? AND s.status='running'
      ORDER BY s.id DESC LIMIT 1`).get(nodeId) as { session_name: string; startup_status: string | null; runtime: string } | undefined;
    const generation = sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid;
    if (!current || !generation || current.startup_status !== "ready") return null;
    const bound = guard.target(nodeId);
    if (bound.session !== current.session_name || bound.occupant !== generation || !bound.pane) return null;
    const observe = () => current.runtime === "codex"
      ? verifyCodexPaneProcess({ target: bound.pane!, tmux: tmuxAdapter })
      : current.runtime === "claude-code" ? verifyClaudePaneRuntime({ target: bound.pane!, tmux: tmuxAdapter }) : Promise.resolve(null);
    const native = await observe();
    if (!native) return null;
    // Read only identity fields. Environment contents and credentials never leave this function.
    const env = (await readFile(`/proc/${native.process.pid}/environ`, "utf8")).split("\0");
    const identity = (name: string) => env.find(line => line.startsWith(name + "="))?.slice(name.length + 1);
    if (identity("OPENRIG_OCCUPANT_GENERATION") !== generation || identity("OPENRIG_NODE_ID") !== nodeId
      || identity("OPENRIG_SESSION_NAME") !== current.session_name) return null;
    const verified = await observe();
    if (!verified || verified.fingerprint !== native.fingerprint || verified.panePid !== native.panePid
      || sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid !== generation
      || (await tmuxAdapter.getPanePid(bound.pane)) !== native.panePid) return null;
    return current.session_name;
  } catch { return null; }
}
