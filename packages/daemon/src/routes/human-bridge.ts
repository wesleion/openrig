import { Hono } from "hono";
import type Database from "better-sqlite3";
import type { QueueRepository } from "../domain/queue-repository.js";
import { HumanDecisionError, type HumanDecisionService, type HumanDecisionInput } from "../domain/human-decision-service.js";
import { HumanBridgeMailbox } from "../domain/gateway/human-bridge-mailbox.js";
import type { HumanBridgeConfig } from "../domain/gateway/human-bridge-config.js";
import { requireSenderIdentity } from "./require-sender-identity.js";

function failure(c: any, e: unknown) {
  if (e instanceof HumanDecisionError) return c.json({ error: e.code, message: e.message }, e.httpStatus);
  return c.json({ error: "human_decision_unavailable", message: "The accepted operation may still be pending; retry with the same requestId" }, 503);
}
export function humanBridgeRoutes(db: Database.Database, native?: { home: string; queue: QueueRepository }) {
  const app = new Hono();
  const mailbox = new HumanBridgeMailbox(db, native);
  app.get("/inbox", c => {
    const bridge = c.get("humanBridge" as never) as HumanBridgeConfig | undefined;
    if (!bridge) return c.json({ error: "bridge_credential_required" }, 401);
    try { return c.json(mailbox.inbox(bridge, c.req.query("cursor"))); }
    catch (e) { return failure(c, e); }
  });
  app.post("/receipts", async c => {
    const bridge = c.get("humanBridge" as never) as HumanBridgeConfig | undefined;
    if (!bridge) return c.json({ error: "bridge_credential_required" }, 401);
    try { return c.json(mailbox.receipt(bridge, await c.req.json())); }
    catch (e) { return failure(c, e); }
  });
  return app;
}
export function humanBridgeAdminRoutes(db: Database.Database, native?: { home: string; queue: QueueRepository }) {
  const app = new Hono();
  const mailbox = new HumanBridgeMailbox(db, native);
  app.post("/:bridgeId/reconcile", async c => {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "invalid_reconciliation" }, 400);
    const identity = requireSenderIdentity(c, { verb: "bridge reconciliation", bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    try { return c.json(mailbox.reconcile(c.req.param("bridgeId"), { ...body, actorSession: identity.session })); }
    catch (e) { return failure(c, e); }
  });
  return app;
}
export function humanAnswerRoutes(service: HumanDecisionService) {
  const app = new Hono();
  app.post("/:qitemId/answer", async c => {
    const bridge = c.get("humanBridge" as never) as HumanBridgeConfig | undefined;
    const body = await c.req.json().catch(() => null) as (HumanDecisionInput & { actorSession?: string }) | null;
    if (!body || !Number.isSafeInteger(body.expectedRevision) || (body.expectedRevision ?? 0) < 1) return c.json({ error: "expected_revision_required" }, 400);
    const identity = bridge ? { ok: true as const, session: bridge.humanAddress }
      : requireSenderIdentity(c, { verb: "human answer", bodyClaim: body.actorSession });
    if (!identity.ok) return identity.response;
    try {
      return c.json(await service.answer(c.req.param("qitemId"), { session: identity.session, scope: bridge ? `bridge:${bridge.id}` : `local:${identity.session}`, aliases: bridge?.legacyAliases }, body));
    } catch (e) { return failure(c, e); }
  });
  return app;
}
