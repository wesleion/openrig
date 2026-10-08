import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { HumanBridgeConfig } from "./human-bridge-config.js";
import { HumanDecisionError, canonicalJson } from "../human-decision-service.js";
import { parseSessionName } from "../session-name.js";
import type { QueueRepository } from "../queue-repository.js";
import type { OutboundDecision } from "./protocol.js";
import { DispatchBuffer } from "./dispatch-buffer.js";

function deliveryId(bridgeId: string, qitemId: string, revision: number, nativeDecisionId?: string): string {
  return `bridge-${createHash("sha256").update(JSON.stringify([bridgeId, qitemId, revision, nativeDecisionId ?? null])).digest("hex").slice(0,32)}`;
}

interface MailEvent { event_id: number; qitem_id: string; revision: number; payload: string; previous_destination_session: string | null }
export class HumanBridgeMailbox {
  constructor(private readonly db: Database.Database, private readonly native?: { home: string; queue: QueueRepository }) {}

  acceptGatewayDecision(bridge: HumanBridgeConfig, decision: OutboundDecision): boolean {
    const input = decision.payload as { qitemId?: string; notificationKey?: string; summary?: string; body?: string };
    if (!input?.qitemId) throw new HumanDecisionError("notification_item_required", 400, "Native HTTP notifications require a queue item");
    const qitemId = input.qitemId;
    return this.db.transaction(() => {
      const prior = this.db.prepare("SELECT decision_id, acknowledged FROM human_bridge_native_dispatch WHERE bridge_id = ? AND native_decision_id = ?").get(bridge.id, decision.decisionId) as { decision_id: string; acknowledged: number } | undefined;
      // A replay of a settled predecessor must not re-enter the pending buffer.
      // Its ledger retains the delivered/superseded distinction.
      if (prior) return prior.acknowledged > 0 || !!this.db.prepare("SELECT 1 FROM human_bridge_dispatch WHERE bridge_id = ? AND decision_id = ? AND status = 'delivered'").get(bridge.id, prior.decision_id);
      const item = this.native?.queue.getById(qitemId);
      if (!item) throw new HumanDecisionError("qitem_not_found", 404, "Native notification item is missing");
      const asked = [bridge.humanAddress, ...bridge.legacyAliases].includes(item.destinationSession);
      const payload = { ...item, destinationSession: bridge.humanAddress, humanIntent: asked ? item.humanIntent ?? "decision" : "update",
        summary: input.summary ?? item.summary, body: input.body ?? item.body, nativeAskedHuman: asked, nativeDestinationSession: item.destinationSession,
        bridgeId: bridge.id, nativeDecisionId: decision.decisionId };
      this.db.prepare("INSERT INTO human_bridge_events(qitem_id, revision, payload) VALUES(?, ?, ?)").run(item.qitemId, item.revision, JSON.stringify(payload));
      const id = deliveryId(bridge.id, item.qitemId, item.revision, decision.decisionId);
      this.db.prepare("INSERT INTO human_bridge_native_dispatch(bridge_id, native_decision_id, decision_id, qitem_id, notification_key) VALUES(?, ?, ?, ?, ?)").run(bridge.id, decision.decisionId, id, item.qitemId, input.notificationKey ?? null);
      return false;
    })();
  }

  private acknowledgeNativeDelivery(bridgeId: string, decisionId: string): void {
    if (!this.native) return;
    const dispatch = this.db.prepare("SELECT payload, receipt, event_id FROM human_bridge_dispatch WHERE bridge_id = ? AND decision_id = ? AND status = 'delivered'").get(bridgeId, decisionId) as { payload: string; receipt: string; event_id: number } | undefined;
    if (!dispatch) return;
    const payload = JSON.parse(dispatch.payload), receipt = JSON.parse(dispatch.receipt);
    const item = this.native.queue.getById(payload.qitem.qitemId);
    const links = this.db.prepare("SELECT native_decision_id, notification_key FROM human_bridge_native_dispatch WHERE bridge_id = ? AND decision_id = ? AND acknowledged = 0").all(bridgeId, decisionId) as Array<{ native_decision_id: string; notification_key: string | null }>;
    if (item) {
      const latest = this.native.queue.transitionLog.latestOwnerNotificationForQitem(item.qitemId);
      const keys = links.map(link => link.notification_key).filter((key): key is string => !!key);
      if (item.revision === payload.qitem.revision && latest) keys.push(`${item.qitemId}:${latest.transitionId}`);
      for (const key of new Set(keys)) {
        if (this.native.queue.transitionLog.hasOwnerNotificationReceipt(item.qitemId, key)) continue;
        this.native.queue.update({ qitemId: item.qitemId, actorSession: "daemon@kernel",
          transitionNote: `http-owner-notification-posted notification_key=${key} bridge=${bridgeId} message_id=${receipt.messageId}` });
      }
      if (payload.qitem.askedHuman && item.humanIntent === "update" && item.state === "pending" && item.revision === payload.qitem.revision && item.destinationSession === (payload.qitem.nativeDestinationSession ?? payload.qitem.destinationSession)) {
        this.native.queue.update({ qitemId: item.qitemId, actorSession: "daemon@kernel", state: "done", closureReason: "no-follow-on", transitionNote: "http-human-update-delivered" });
      }
    }
    for (const link of links) {
      new DispatchBuffer(this.native.home).ack(link.native_decision_id);
      this.db.prepare("UPDATE human_bridge_native_dispatch SET acknowledged = 1 WHERE bridge_id = ? AND native_decision_id = ?").run(bridgeId, link.native_decision_id);
    }
    // A newer confirmed card also retires obsolete, unattempted notifications.
    // Disposition 2 records supersession; it never fabricates a delivery receipt.
    const obsolete = this.db.prepare(`
      SELECT n.native_decision_id FROM human_bridge_native_dispatch n
      LEFT JOIN human_bridge_dispatch d ON d.bridge_id = n.bridge_id AND d.decision_id = n.decision_id
      WHERE n.bridge_id = ? AND n.qitem_id = ? AND n.acknowledged = 0
        AND (d.status IS NULL OR d.status IN ('pending','failed','superseded'))
        AND EXISTS (SELECT 1 FROM human_bridge_events e WHERE e.event_id < ?
          AND json_extract(e.payload, '$.nativeDecisionId') = n.native_decision_id
          AND json_extract(e.payload, '$.bridgeId') = n.bridge_id)
    `).all(bridgeId, payload.qitem.qitemId, dispatch.event_id) as Array<{ native_decision_id: string }>;
    for (const link of obsolete) {
      new DispatchBuffer(this.native.home).ack(link.native_decision_id);
      this.db.prepare("UPDATE human_bridge_native_dispatch SET acknowledged = 2 WHERE bridge_id = ? AND native_decision_id = ?").run(bridgeId, link.native_decision_id);
    }
  }

  recoverNativeDeliveries(): void {
    const rows = this.db.prepare("SELECT DISTINCT n.bridge_id, n.decision_id FROM human_bridge_native_dispatch n JOIN human_bridge_dispatch d ON d.bridge_id = n.bridge_id AND d.decision_id = n.decision_id WHERE n.acknowledged = 0 AND d.status = 'delivered'").all() as Array<{ bridge_id: string; decision_id: string }>;
    for (const row of rows) this.acknowledgeNativeDelivery(row.bridge_id, row.decision_id);
  }

  inbox(bridge: HumanBridgeConfig, cursor?: string) {
    if (cursor !== undefined && !/^(0|[1-9][0-9]*)$/.test(cursor)) throw new HumanDecisionError("invalid_cursor", 400, "Invalid mailbox cursor");
    const start = cursor === undefined ? undefined : Number(cursor);
    if (start !== undefined && !Number.isSafeInteger(start)) throw new HumanDecisionError("invalid_cursor", 400, "Invalid mailbox cursor");
    return this.db.transaction(() => {
      this.db.prepare("INSERT INTO human_bridge_presence(bridge_id, human_address, last_poll_at) VALUES(?, ?, ?) ON CONFLICT(bridge_id) DO UPDATE SET human_address = excluded.human_address, last_poll_at = excluded.last_poll_at").run(bridge.id, bridge.humanAddress, new Date().toISOString());
      const end = (this.db.prepare("SELECT COALESCE(MAX(event_id),0) AS n FROM human_bridge_events").get() as { n: number }).n;
      if (start !== undefined && start > end) throw new HumanDecisionError("cursor_ahead", 409, "Mailbox history changed; request a new snapshot");
      const rows = (start === undefined
        ? this.db.prepare("SELECT e.* FROM human_bridge_events e JOIN (SELECT qitem_id, MAX(event_id) AS latest FROM human_bridge_events WHERE json_extract(payload, '$.bridgeId') IS NULL OR json_extract(payload, '$.bridgeId') = ? GROUP BY qitem_id) x ON x.latest = e.event_id ORDER BY e.event_id").all(bridge.id)
        : this.db.prepare("SELECT * FROM human_bridge_events WHERE event_id > ? AND event_id <= ? AND (json_extract(payload, '$.bridgeId') IS NULL OR json_extract(payload, '$.bridgeId') = ?) ORDER BY event_id").all(start, end, bridge.id)) as MailEvent[];
      const recipients = [bridge.humanAddress, ...bridge.legacyAliases];
      const known = new Map<string, boolean>();
      const lastEvent = new Map<string, number>();
      const previous = this.db.prepare("SELECT payload FROM human_bridge_dispatch WHERE bridge_id = ? AND human_address = ? ORDER BY event_id").all(bridge.id, bridge.humanAddress) as Array<{ payload: string }>;
      for (const row of previous) {
        const payload = JSON.parse(row.payload);
        known.set(payload.qitem.qitemId, payload.type !== "withdrawn");
        lastEvent.set(payload.qitem.qitemId, Number(payload.eventId));
      }
      const events = [];
      const latest = new Map<string, MailEvent>();
      for (const row of rows) {
        const item = JSON.parse(row.payload);
        const ownTask = !recipients.includes(item.destinationSession) && recipients.includes(item.sourceSession) && parseSessionName(item.destinationSession).kind === "canonical";
        if (recipients.includes(item.destinationSession) || ownTask || recipients.includes(row.previous_destination_session ?? "") || known.get(row.qitem_id)) {
          latest.set(row.qitem_id, row);
        }
      }
      for (const row of [...latest.values()].sort((a, b) => a.event_id - b.event_id)) {
        if ((lastEvent.get(row.qitem_id) ?? 0) > row.event_id) continue;
        const item = JSON.parse(row.payload);
        const ownTask = !recipients.includes(item.destinationSession) && recipients.includes(item.sourceSession) && parseSessionName(item.destinationSession).kind === "canonical";
        const admitted = recipients.includes(item.destinationSession) || ownTask;
        if (!admitted && !recipients.includes(row.previous_destination_session ?? "") && !known.get(row.qitem_id)) continue;
        const decisionId = deliveryId(bridge.id, row.qitem_id, row.revision, item.nativeDecisionId);
        const source = parseSessionName(item.sourceSession);
        const parsed = ownTask ? parseSessionName(item.destinationSession) : source.kind === "canonical" ? source : parseSessionName(item.destinationSession);
        const rigId = parsed.kind === "canonical" ? parsed.rig : null;
        const project = rigId ? bridge.origins[rigId] : undefined;
        const qitem = admitted ? { ...item, askedHuman: item.nativeAskedHuman ?? !ownTask, humanIntent: ownTask ? "update" : item.humanIntent ?? "decision",
          origin: { hostId: null, rigId, projectId: project?.projectId ?? null, projectName: project?.projectName ?? null, targetRepo: item.targetRepo ?? null } }
          : { qitemId: row.qitem_id, revision: row.revision };
        const seen = this.db.prepare("SELECT 1 FROM human_bridge_dispatch WHERE bridge_id = ? AND human_address = ? AND json_extract(payload, '$.qitem.qitemId') = ?").get(bridge.id, bridge.humanAddress, row.qitem_id);
        const type = !admitted ? "withdrawn" : item.state === "canceled" ? "canceled" : item.state === "done" ? "resolved" : item.state === "expired" ? "expired" : !seen ? "created" : "revised";
        const payload = { eventId: String(row.event_id), decisionId, type, qitem };
        this.db.prepare("UPDATE human_bridge_dispatch SET status = 'superseded' WHERE bridge_id = ? AND human_address = ? AND event_id < ? AND status IN ('pending','failed') AND json_extract(payload, '$.qitem.qitemId') = ?").run(bridge.id, bridge.humanAddress, row.event_id, row.qitem_id);
        this.db.prepare("INSERT OR IGNORE INTO human_bridge_dispatch(bridge_id, human_address, decision_id, event_id, payload) VALUES(?, ?, ?, ?, ?)").run(bridge.id, bridge.humanAddress, decisionId, row.event_id, JSON.stringify(payload));
        const dispatch = this.db.prepare("SELECT status, payload FROM human_bridge_dispatch WHERE bridge_id = ? AND decision_id = ?").get(bridge.id, decisionId) as { status: string; payload: string };
        events.push({ ...JSON.parse(dispatch.payload), deliveryStatus: dispatch.status });
      }
      // This durable ledger is authoritative for HTTP delivery. Polling never acknowledges delivery.
      const pending = this.db.prepare("SELECT decision_id, payload, status FROM human_bridge_dispatch WHERE bridge_id = ? AND human_address = ? AND status IN ('pending','failed','indeterminate','attempting') ORDER BY event_id").all(bridge.id, bridge.humanAddress) as Array<{ decision_id: string; payload: string; status: string }>;
      const uncertain = new Set(pending.filter(p => ["attempting", "indeterminate"].includes(p.status)).map(p => JSON.parse(p.payload).qitem.qitemId));
      const cards = new Map<string, { chatId: string; messageId: string }>();
      const delivered = this.db.prepare("SELECT payload, receipt FROM human_bridge_dispatch WHERE bridge_id = ? AND human_address = ? AND status = 'delivered' ORDER BY event_id DESC").all(bridge.id, bridge.humanAddress) as Array<{ payload: string; receipt: string | null }>;
      for (const row of delivered) {
        const qitemId = JSON.parse(row.payload).qitem.qitemId, receipt = JSON.parse(row.receipt ?? "null");
        if (!cards.has(qitemId) && receipt?.chatId && receipt?.messageId) cards.set(qitemId, { chatId: receipt.chatId, messageId: receipt.messageId });
      }
      return { snapshot: start === undefined, cursor: String(end), events: events.map(e => ({ ...e,
        message: cards.get(e.qitem.qitemId) ?? null,
        deliveryStatus: e.deliveryStatus === "attempting" ? "indeterminate" : e.deliveryStatus,
        retryAllowed: ["pending", "failed"].includes(e.deliveryStatus) && !uncertain.has(e.qitem.qitemId) })),
        pending: pending.map(p => { const payload = JSON.parse(p.payload); return { ...payload,
          message: cards.get(payload.qitem.qitemId) ?? null,
          deliveryStatus: p.status === "attempting" ? "indeterminate" : p.status,
          retryAllowed: ["pending", "failed"].includes(p.status) && !uncertain.has(payload.qitem.qitemId) }; }) };
    })();
  }

  receipt(bridge: HumanBridgeConfig, input: { decisionId: string; status: string; attemptId: string; chatId?: string; messageId?: string }) {
    if (!input || typeof input.decisionId !== "string" || !["attempting", "delivered", "failed", "indeterminate"].includes(input.status) || typeof input.attemptId !== "string" || !input.attemptId.trim() ||
        (input.status === "delivered" && (typeof input.chatId !== "string" || !input.chatId || typeof input.messageId !== "string" || !input.messageId))) throw new HumanDecisionError("invalid_receipt", 400, "A delivery receipt requires decisionId, attemptId, status, and Telegram message coordinates for success");
    const result = this.db.transaction(() => {
      const row = this.db.prepare("SELECT * FROM human_bridge_dispatch WHERE bridge_id = ? AND human_address = ? AND decision_id = ?").get(bridge.id, bridge.humanAddress, input.decisionId) as { status: string; receipt: string | null; payload: string } | undefined;
      if (!row) throw new HumanDecisionError("delivery_not_found", 404, "Delivery not found for this bridge");
      const previous = row.receipt ? JSON.parse(row.receipt) : undefined;
      if (input.status === "attempting") {
        const used = this.db.prepare("SELECT 1 FROM human_bridge_receipt_log WHERE bridge_id = ? AND decision_id = ? AND attempt_id = ?").get(bridge.id, input.decisionId, input.attemptId);
        if (!["pending", "failed"].includes(row.status) || used) return { decisionId: input.decisionId, status: row.status, sendAllowed: false };
        const payload = JSON.parse(row.payload);
        const current = this.db.prepare("SELECT human_revision, destination_session FROM queue_items WHERE qitem_id = ?").get(payload.qitem.qitemId) as { human_revision: number; destination_session: string } | undefined;
        const validWithdrawal = payload.type === "withdrawn" && current && ![bridge.humanAddress, ...bridge.legacyAliases].includes(current.destination_session);
        if (!current || (!validWithdrawal && current.human_revision !== payload.qitem.revision)) {
          this.db.prepare("UPDATE human_bridge_dispatch SET status = 'superseded' WHERE bridge_id = ? AND decision_id = ?").run(bridge.id, input.decisionId);
          return { decisionId: input.decisionId, status: "superseded", sendAllowed: false };
        }
        const uncertain = this.db.prepare("SELECT decision_id FROM human_bridge_dispatch WHERE bridge_id = ? AND human_address = ? AND status IN ('attempting','indeterminate') AND json_extract(payload, '$.qitem.qitemId') = ?").get(bridge.id, bridge.humanAddress, JSON.parse(row.payload).qitem.qitemId);
        if (uncertain) return { decisionId: input.decisionId, status: "indeterminate", sendAllowed: false };
      } else {
        if (canonicalJson(previous) === canonicalJson(input)) return { decisionId: input.decisionId, status: row.status, sendAllowed: false };
        if (row.status !== "attempting" || previous?.attemptId !== input.attemptId) throw new HumanDecisionError("receipt_conflict", 409, "A terminal receipt must complete its reserved attempt; uncertain outcomes require operator reconciliation");
      }
      this.db.prepare("UPDATE human_bridge_dispatch SET status = ?, receipt = ? WHERE bridge_id = ? AND decision_id = ?").run(input.status, JSON.stringify(input), bridge.id, input.decisionId);
      this.db.prepare("INSERT OR IGNORE INTO human_bridge_receipt_log(bridge_id, decision_id, attempt_id, status, payload) VALUES(?, ?, ?, ?, ?)").run(bridge.id, input.decisionId, input.attemptId, input.status, JSON.stringify(input));
      return { decisionId: input.decisionId, status: input.status, sendAllowed: input.status === "attempting" };
    })();
    if (result.status === "delivered") this.acknowledgeNativeDelivery(bridge.id, input.decisionId);
    return result;
  }

  reconcile(bridgeId: string, input: { decisionId: string; requestId: string; actorSession: string; action: "confirm" | "retry"; chatId?: string; messageId?: string }) {
    if (typeof input?.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 240 || typeof input.actorSession !== "string" || !input.actorSession || !["confirm", "retry"].includes(input.action) ||
        (input.action === "confirm" && (typeof input.chatId !== "string" || !input.chatId || typeof input.messageId !== "string" || !input.messageId))) throw new HumanDecisionError("invalid_reconciliation", 400, "Operator reconciliation requires requestId, actorSession, action, and string message coordinates when confirming");
    const result = this.db.transaction(() => {
      const previous = this.db.prepare("SELECT payload FROM human_bridge_receipt_log WHERE bridge_id = ? AND decision_id = ? AND attempt_id = ? AND status = 'reconciled'").get(bridgeId, input.decisionId, input.requestId) as { payload: string } | undefined;
      if (previous && canonicalJson(JSON.parse(previous.payload)) !== canonicalJson(input)) throw new HumanDecisionError("request_id_conflict", 409, "Reconciliation requestId already used");
      const row = this.db.prepare("SELECT status, payload FROM human_bridge_dispatch WHERE bridge_id = ? AND decision_id = ?").get(bridgeId, input.decisionId) as { status: string; payload: string } | undefined;
      if (!row) throw new HumanDecisionError("delivery_not_found", 404, "Delivery not found");
      if (previous) return { decisionId: input.decisionId, status: row.status };
      if (row.status === "delivered") throw new HumanDecisionError("delivery_final", 409, "Delivered messages cannot be resent through reconciliation");
      const payload = JSON.parse(row.payload);
      const current = this.db.prepare("SELECT human_revision FROM queue_items WHERE qitem_id = ?").get(payload.qitem.qitemId) as { human_revision: number } | undefined;
      const status = input.action === "confirm" ? "delivered" : current?.human_revision === payload.qitem.revision ? "pending" : "superseded";
      this.db.prepare("UPDATE human_bridge_dispatch SET status = ?, receipt = ? WHERE bridge_id = ? AND decision_id = ?").run(status, input.action === "confirm" ? JSON.stringify(input) : null, bridgeId, input.decisionId);
      this.db.prepare("INSERT INTO human_bridge_receipt_log(bridge_id, decision_id, attempt_id, status, payload) VALUES(?, ?, ?, 'reconciled', ?)").run(bridgeId, input.decisionId, input.requestId, JSON.stringify(input));
      return { decisionId: input.decisionId, status };
    })();
    if (result.status === "delivered") this.acknowledgeNativeDelivery(bridgeId, input.decisionId);
    return result;
  }
}
