import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import { HumanDecisionError, canonicalJson } from "../human-decision-service.js";
import type { HumanBridgeConfig } from "./human-bridge-config.js";

export function prepareBridgeCreate(db: Database.Database, bridge: HumanBridgeConfig, body: Record<string, unknown>): { priorResult?: unknown } {
  if (typeof body.requestId !== "string" || !body.requestId.trim() || body.requestId.length > 240 || typeof body.qitemId !== "string" || !body.qitemId.trim()) throw new HumanDecisionError("request_id_required", 400, "Bridge creation requires requestId and a stable qitemId");
  if (typeof body.destinationSession !== "string" || !bridge.allowedDestinations.includes(body.destinationSession) || body.hostId) throw new HumanDecisionError("destination_forbidden", 403, "Destination is not permitted for this bridge");
  const digest = createHash("sha256").update(canonicalJson({ ...body, sourceSession: bridge.humanAddress })).digest("hex");
  return db.transaction(() => {
    const prior = db.prepare("SELECT digest, result FROM human_bridge_creates WHERE bridge_id = ? AND request_id = ?").get(bridge.id, body.requestId) as { digest: string; result: string | null } | undefined;
    if (prior) {
      if (prior.digest !== digest) throw new HumanDecisionError("request_id_conflict", 409, "The requestId was already used with a different create payload");
      return prior.result ? { priorResult: JSON.parse(prior.result) } : {};
    }
    if (db.prepare("SELECT 1 FROM queue_items WHERE qitem_id = ?").get(body.qitemId) || db.prepare("SELECT 1 FROM human_bridge_creates WHERE qitem_id = ?").get(body.qitemId)) throw new HumanDecisionError("qitem_id_conflict", 409, "The qitemId belongs to another operation");
    db.prepare("INSERT INTO human_bridge_creates(bridge_id, request_id, digest, qitem_id) VALUES(?, ?, ?, ?)").run(bridge.id, body.requestId, digest, body.qitemId);
    return {};
  })();
}
