import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { serve } from "@hono/node-server";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { Hono } from "hono";
import { createDb } from "../src/db/connection.js";
import { migrate } from "../src/db/migrate.js";
import { ALL_MIGRATIONS } from "../src/db/all-migrations.js";
import { EventBus } from "../src/domain/event-bus.js";
import { QueueRepository } from "../src/domain/queue-repository.js";
import { HumanDecisionService } from "../src/domain/human-decision-service.js";
import { HumanBridgeMailbox } from "../src/domain/gateway/human-bridge-mailbox.js";
import { prepareBridgeCreate } from "../src/domain/gateway/human-bridge-create.js";
import { addHumanFragment, type HumanFragment } from "../src/domain/gateway/human-registry.js";
import { type HumanBridgeConfig } from "../src/domain/gateway/human-bridge-config.js";
import { resolveHermesReadiness } from "../src/domain/gateway/hermes-readiness.js";
import { InboundRouter } from "../src/domain/gateway/slack/inbound.js";
import { SeenStore, DeadLetterStore } from "../src/domain/gateway/slack/state-store.js";
import { networkWriteAuth } from "../src/middleware/network-write-auth.js";
import { humanAnswerRoutes, humanBridgeRoutes, humanBridgeAdminRoutes } from "../src/routes/human-bridge.js";
import { queueRoutes } from "../src/routes/queue.js";
import { assertBindAuthInvariant } from "../src/middleware/auth-bearer-token.js";
import { buildHumanBridgeDelivery } from "../src/domain/gateway/human-bridge-delivery.js";
import { DispatchBuffer } from "../src/domain/gateway/dispatch-buffer.js";
import type { OutboundDecision } from "../src/domain/gateway/protocol.js";
import { buildSlackGatewayWire } from "../src/domain/gateway/slack/slack-subsystem.js";
import { OUTBOUND_OP } from "../src/domain/gateway/slack/outbound-driver.js";

const token = "test-only-bridge-token-32-characters";
const actor = { session: "weslei@external", scope: "bridge:hermes", aliases: ["human@kernel"] };
const human: HumanFragment = { entityId: "weslei", class: "human", displayName: "Weslei", address: actor.session,
  prefs: { deliveryClass: "A" }, connectorBindings: [{ kind: "hermes", connectorRef: "hermes", secretsRef: "env:TEST_BRIDGE", role: "primary", handle: "123" }] };
const bridge: HumanBridgeConfig = { id: "hermes", enabled: true, humanAddress: actor.session, legacyAliases: actor.aliases,
  tokenSha256: createHash("sha256").update(token).digest("hex"), scopes: ["inbox", "receipts", "answer", "create"],
  allowedDestinations: ["builder@agency-sites"], origins: { "agency-sites": { projectId: "agency-sites", projectName: "Agency Sites" } } };
const questions = ["q1", "q2"].map(id => ({ id, question: id, options: [{ id: "yes", label: "Sim" }, { id: "no", label: "Não" }] }));

describe("native human bridge", () => {
  let home: string, db: ReturnType<typeof createDb>, queue: QueueRepository, service: HumanDecisionService;
  let resolve: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "openrig-bridge-test-"));
    db = createDb(join(home, "test.sqlite")); migrate(db, ALL_MIGRATIONS);
    queue = new QueueRepository(db, new EventBus(db), { loadHumanRegistry: () => ({ ok: true, entities: [human] }) });
    resolve = vi.fn(async () => "not-applicable" as const);
    service = new HumanDecisionService(db, queue, resolve);
  });
  afterEach(() => { db.close(); rmSync(home, { recursive: true, force: true }); });
  async function ask(structured = true) {
    return queue.create({ qitemId: "human-request", sourceSession: "builder@agency-sites", destinationSession: "human@kernel", body: "Escolha", summary: "Escolha", evidenceRef: "test:evidence", humanIntent: "decision", humanQuestions: structured ? questions : undefined, nudge: false });
  }
  async function humanBlocked(id = "legacy-blocker") {
    const q = await queue.create({ qitemId: id, sourceSession: "coordinator@elsewhere", destinationSession: "worker@elsewhere",
      body: "Decision needed", summary: "Decision needed", evidenceRef: "test:blocker-evidence", nudge: false });
    queue.update({ qitemId: q.qitemId, actorSession: q.destinationSession, state: "blocked", blockedOn: "human@kernel" });
    return queue.getById(q.qitemId)!;
  }
  it("admits legacy human blockers outside the task allowlist after an advanced cursor and answers through HTTP exactly once", async () => {
    const a = app(), q = await humanBlocked();
    const box = new HumanBridgeMailbox(db);
    const cursor = String((db.prepare("SELECT MAX(event_id) n FROM human_bridge_events").get() as { n: number }).n);
    const inbox = box.inbox(bridge, cursor);
    const frame = inbox.pending.find(p => p.qitem.qitemId === q.qitemId)!;
    expect(frame.qitem.humanIntent).toBe("decision"); expect(frame.qitem.askedHuman).toBe(true);
    expect(frame.qitem.destinationSession).toBe("worker@elsewhere");
    const input = { requestId: "tg-123-55", expectedRevision: q.revision, decision: "Continue with option B" };
    const request = () => a.request("/api/queue/" + q.qitemId + "/answer", {
      method: "POST", headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const first = await request(); expect(first.status).toBe(200);
    const result = await first.json();
    const repeat = await request(); expect(repeat.status).toBe(200); expect(await repeat.json()).toEqual(result);
    expect(queue.getById(q.qitemId)?.state).toBe("done");
    const replies = db.prepare("SELECT source_session, destination_session FROM queue_items WHERE qitem_id LIKE 'qitem-human-answer-%'").all();
    expect(replies).toEqual([{ source_session: actor.session, destination_session: "worker@elsewhere" }]);
    expect(box.inbox(bridge, inbox.cursor).pending.some(p => p.qitem.qitemId === q.qitemId && p.type === "resolved")).toBe(true);
  });
  it("validates human blocker identity, revisions, and the current blocked state", async () => {
    const q = await humanBlocked("validation-blocker");
    await expect(service.answer(q.qitemId, { session: "other@external", scope: "other" },
      { requestId: "wrong", decision: "Yes" })).rejects.toMatchObject({ code: "not_the_asked_human" });
    await expect(service.answer(q.qitemId, actor, { requestId: "stale", expectedRevision: q.revision - 1,
      decision: "Yes" })).rejects.toMatchObject({ code: "revision_conflict" });
    queue.update({ qitemId: q.qitemId, actorSession: q.destinationSession, state: "pending", blockedOn: null });
    await expect(service.answer(q.qitemId, actor, { requestId: "unblocked", decision: "Yes" })).rejects.toMatchObject({ code: "not_the_asked_human" });
    expect(db.prepare("SELECT count(*) n FROM human_decisions").get()).toEqual({ n: 0 });
  });
  it("supersedes unsent out-of-scope task updates before a cached sender can reserve them, without changing tasks", async () => {
    const ids = ["teste-fumaca-0001", "e5c-stack-playbooks", "e5c-ajuste-stack", "t1-fikfrio"];
    for (const id of ids) await queue.create({ qitemId: id, sourceSession: actor.session,
      destinationSession: "intake-lead@sites-lab", body: id, summary: id, nudge: false });
    const box = new HumanBridgeMailbox(db), legacy = box.inbox({ ...bridge, allowedDestinations: ["intake-lead@sites-lab"] });
    expect(legacy.pending).toHaveLength(4);
    const old = legacy.pending[0];
    expect(box.receipt(bridge, { decisionId: old.decisionId, attemptId: "cached-send", status: "attempting" }))
      .toMatchObject({ status: "superseded", sendAllowed: false });
    expect(box.inbox(bridge, legacy.cursor).pending).toHaveLength(0);
    expect(box.inbox(bridge).events).toHaveLength(0);
    expect(db.prepare("SELECT status, receipt FROM human_bridge_dispatch").all()).toEqual(ids.map(() => ({ status: "superseded", receipt: null })));
    expect(db.prepare("SELECT COUNT(*) n FROM human_bridge_receipt_log WHERE status='superseded'").get()).toEqual({ n: 4 });
    expect(db.prepare("SELECT DISTINCT state FROM queue_items").all()).toEqual([{ state: "pending" }]);
  });
  it("excludes disallowed task updates but preserves uncertain attempts for explicit reconciliation", async () => {
    await queue.create({ qitemId: "scope-change", sourceSession: actor.session,
      destinationSession: "old@other", body: "old task", summary: "old task", nudge: false });
    const box = new HumanBridgeMailbox(db), broad = { ...bridge, allowedDestinations: ["old@other"] };
    const frame = box.inbox(broad).pending[0];
    box.receipt(broad, { decisionId: frame.decisionId, attemptId: "in-flight", status: "attempting" });
    expect(box.inbox(bridge).pending).toHaveLength(0);
    expect(db.prepare("SELECT status FROM human_bridge_dispatch").get()).toEqual({ status: "attempting" });
  });
  function app() {
    const registered = addHumanFragment(human, home);
    if (!registered.ok) throw new Error(registered.error);
    mkdirSync(join(home, "gateway", "bridges"), { recursive: true });
    writeFileSync(join(home, "gateway", "bridges", "hermes.json"), JSON.stringify(bridge));
    const a = new Hono();
    a.use("*", networkWriteAuth({ home, operatorTokens: ["operator-test-token"], peerAddress: c => c.req.header("Test-Peer") ?? "100.114.220.73" }));
    a.use("*", async (c, next) => { c.set("db" as never, db); c.set("queueRepo" as never, queue); await next(); });
    a.route("/api/queue", humanAnswerRoutes(service)); a.route("/api/queue", queueRoutes());
    a.route("/api/bridge", humanBridgeRoutes(db)); a.route("/api/bridge-admin", humanBridgeAdminRoutes(db));
    return a;
  }
  it("keeps native notifications pending until a durable HTTP receipt, then recovers the acknowledgement", async () => {
    app(); const q = await ask();
    const delivery = buildHumanBridgeDelivery(home, queue), buffer = new DispatchBuffer(home);
    const native: OutboundDecision = { kind: "outbound_decision", decisionId: "native-1", op: "slack.post_message",
      entityBindingRef: actor.session, payload: { qitemId: q.qitemId, notificationKey: "test-native-1" } };
    buffer.enqueue(native);
    expect(await delivery.deliver(native)).toEqual({ ok: false, class: "http-pull-pending" });
    const box = new HumanBridgeMailbox(db, { home, queue });
    const card = box.inbox(bridge).pending[0];
    expect(card.qitem.askedHuman).toBe(true);
    box.receipt(bridge, { decisionId: card.decisionId, attemptId: "attempt-1", status: "attempting" });
    expect(buffer.pending()).toHaveLength(1);
    // Simulate a process exit after committing the receipt, before native ack.
    new HumanBridgeMailbox(db).receipt(bridge, { decisionId: card.decisionId, attemptId: "attempt-1", status: "delivered", chatId: "123", messageId: "456" });
    expect(buffer.pending()).toHaveLength(1);
    buildHumanBridgeDelivery(home, queue);
    expect(buffer.pending()).toHaveLength(0);
    expect(queue.transitionLog.hasOwnerNotificationReceipt(q.qitemId, "test-native-1")).toBe(true);
    expect(queue.getById(q.qitemId)?.state).toBe("pending");
    expect(await delivery.deliver(native)).toEqual({ ok: true });
  });
  it("retires superseded native alerts only after the newest card is confirmed, without inventing an older receipt", async () => {
    app(); const q = await ask(); const delivery = buildHumanBridgeDelivery(home, queue), buffer = new DispatchBuffer(home);
    for (const id of ["old", "new"]) {
      const native: OutboundDecision = { kind: "outbound_decision", decisionId: id, op: "slack.post_message",
        entityBindingRef: actor.session, payload: { qitemId: q.qitemId, notificationKey: id, summary: id } };
      buffer.enqueue(native); await delivery.deliver(native);
    }
    const box = new HumanBridgeMailbox(db, { home, queue }), card = box.inbox(bridge).pending[0];
    expect(card.qitem.summary).toBe("new");
    expect(buffer.pending()).toHaveLength(2);
    box.receipt(bridge, { decisionId: card.decisionId, attemptId: "new-attempt", status: "attempting" });
    box.receipt(bridge, { decisionId: card.decisionId, attemptId: "new-attempt", status: "delivered", chatId: "123", messageId: "789" });
    expect(buffer.pending()).toHaveLength(0);
    expect(queue.transitionLog.hasOwnerNotificationReceipt(q.qitemId, "new")).toBe(true);
    expect(queue.transitionLog.hasOwnerNotificationReceipt(q.qitemId, "old")).toBe(false);
    expect((db.prepare("SELECT acknowledged FROM human_bridge_native_dispatch WHERE native_decision_id = 'old'").get() as { acknowledged: number }).acknowledged).toBe(2);
    expect(await delivery.deliver({ kind: "outbound_decision", decisionId: "old", op: OUTBOUND_OP,
      entityBindingRef: actor.session, payload: { qitemId: q.qitemId, notificationKey: "old" } })).toEqual({ ok: true });
    expect(queue.transitionLog.hasOwnerNotificationReceipt(q.qitemId, "old")).toBe(false);
  });
  it("closes an informational human item only after delivery and preserves human-authored agent tasks", async () => {
    app(); const box = new HumanBridgeMailbox(db, { home, queue });
    const update = await queue.create({ qitemId: "info", sourceSession: "builder@agency-sites", destinationSession: actor.session, summary: "Info", body: "Info", humanIntent: "update", nudge: false });
    const card = box.inbox(bridge).pending[0];
    box.receipt(bridge, { decisionId: card.decisionId, attemptId: "info", status: "attempting" });
    expect(queue.getById(update.qitemId)?.state).toBe("pending");
    box.receipt(bridge, { decisionId: card.decisionId, attemptId: "info", status: "delivered", chatId: "123", messageId: "99" });
    expect(queue.getById(update.qitemId)?.state).toBe("done");
    const task = await queue.create({ qitemId: "task", sourceSession: actor.session, destinationSession: "builder@agency-sites", summary: "Task", body: "Task", nudge: false });
    const next = box.inbox(bridge).pending.find(p => p.qitem.qitemId === task.qitemId)!;
    expect(next.qitem.humanIntent).toBe("update"); expect(next.qitem.askedHuman).toBe(false);
    expect(next.qitem.origin.rigId).toBe("agency-sites");
    box.receipt(bridge, { decisionId: next.decisionId, attemptId: "task", status: "attempting" });
    box.receipt(bridge, { decisionId: next.decisionId, attemptId: "task", status: "delivered", chatId: "123", messageId: "100" });
    expect(queue.getById(task.qitemId)?.state).toBe("pending");
  });
  it("advertises HTTP delivery with Slack disabled and never sends a Hermes notification to Slack", async () => {
    app(); const q = await ask();
    const fetchImpl = vi.fn();
    const wire = buildSlackGatewayWire({ home, queueRepo: queue, fetchImpl,
      alternateDelivery: buildHumanBridgeDelivery(home, queue) });
    expect(wire.dispatcher.dispatch(OUTBOUND_OP, actor.session, { qitemId: q.qitemId }, { decisionId: "hermes-only" }).ok).toBe(true);
    await vi.waitFor(() => expect(new HumanBridgeMailbox(db).inbox(bridge).pending[0].qitem.nativeDecisionId).toBe("hermes-only"));
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(new DispatchBuffer(home).pending()).toHaveLength(1);
    wire.stop();
  });
  it("records partial answers, finishes once, and preserves canonical actor with legacy alias", async () => {
    const q = await ask();
    const first = await service.answer(q.qitemId, actor, { requestId: "click1", expectedRevision: q.revision, answers: { q1: "yes" } });
    expect(first.status).toBe("partial"); expect(first.remainingQuestions).toEqual(["q2"]);
    expect(resolve).not.toHaveBeenCalled(); expect(db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual({ n: 1 });
    const input = { requestId: "click2", expectedRevision: first.revision, answers: { q2: "no" } };
    const final = await service.answer(q.qitemId, actor, input);
    expect(final.status).toBe("resolved"); expect(queue.getById(q.qitemId)?.humanAnswers).toEqual({ q1: "yes", q2: "no" });
    expect(queue.getById(q.qitemId)?.destinationSession).toBe("human@kernel");
    expect(await service.answer(q.qitemId, actor, input)).toEqual(final);
    expect(resolve).toHaveBeenCalledTimes(1); expect(db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual({ n: 2 });
    expect(db.prepare("SELECT actor_session FROM human_decisions WHERE request_id = 'click2'").get()).toEqual({ actor_session: "weslei@external" });
  });
  it("rejects stale revisions, wrong humans, unknown options, and request ID reuse without side effects", async () => {
    const q = await ask(); const input = { requestId: "same", expectedRevision: q.revision, answers: { q1: "yes" } };
    await expect(service.answer(q.qitemId, { session: "other@external", scope: "other" }, input)).rejects.toMatchObject({ httpStatus: 403 });
    await expect(service.answer(q.qitemId, actor, { ...input, answers: { q1: "invalid" } })).rejects.toMatchObject({ code: "unknown_option" });
    await service.answer(q.qitemId, actor, input);
    await expect(service.answer(q.qitemId, actor, { ...input, answers: { q1: "no" } })).rejects.toMatchObject({ code: "request_id_conflict" });
    await expect(service.answer(q.qitemId, actor, { ...input, requestId: "new" })).rejects.toMatchObject({ code: "revision_conflict" });
  });
  it("retains a continuation intent after a failure and recovers without duplicating its qitem", async () => {
    const q = await ask(false); resolve.mockRejectedValueOnce(new Error("temporary resolver failure"));
    const input = { requestId: "voice1", expectedRevision: q.revision, decision: "Prosseguir" };
    await expect(service.answer(q.qitemId, actor, input)).rejects.toThrow("temporary resolver failure");
    expect(db.prepare("SELECT state FROM human_decisions").get()).toEqual({ state: "recorded" });
    const restarted = new HumanDecisionService(db, queue, resolve); await restarted.recover();
    expect(queue.getById(q.qitemId)?.state).toBe("done"); expect(queue.getById(q.qitemId)?.humanAnswers).toBeNull();
    expect(db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual({ n: 2 });
    expect((await restarted.answer(q.qitemId, actor, input)).status).toBe("resolved");
  });
  it("does not resolve updates or canceled requests", async () => {
    const q = await ask(); queue.update({ qitemId: q.qitemId, actorSession: "human@kernel", state: "canceled" });
    await expect(service.answer(q.qitemId, actor, { requestId: "late", expectedRevision: service.revision(q.qitemId), answers: { q1: "yes" } })).rejects.toMatchObject({ code: "decision_closed" });
    expect(resolve).not.toHaveBeenCalled();
  });
  it("replays revisions and closure from another channel, with stable dispatch IDs", async () => {
    const q = await ask(), mailbox = new HumanBridgeMailbox(db), before = mailbox.inbox(bridge);
    expect(before.events[0]?.qitem.origin.projectId).toBe("agency-sites"); expect(before.events[0]?.qitem.humanQuestions).toEqual(questions);
    expect(mailbox.inbox(bridge).events[0]).toEqual(before.events[0]);
    queue.recordHumanAnswer({ qitemId: q.qitemId, actorSession: "human@kernel", questionId: "q1", optionId: "yes" });
    const partial = mailbox.inbox(bridge, before.cursor);
    expect(partial.events.map(e => e.type)).toEqual(["revised"]);
    queue.update({ qitemId: q.qitemId, actorSession: "human@kernel", state: "done", closureReason: "no-follow-on", transitionNote: "Resolved elsewhere" });
    const delta = new HumanBridgeMailbox(db).inbox(bridge, partial.cursor);
    expect(delta.events.map(e => e.type)).toEqual(["resolved"]);
    expect(delta.events[0]?.qitem.revision).toBeGreaterThan(partial.events[0]?.qitem.revision);
  });
  it("never grants another send after a reserved attempt or an uncertain receipt", async () => {
    await ask(); let mailbox = new HumanBridgeMailbox(db); const decisionId = mailbox.inbox(bridge).events[0]!.decisionId;
    const attempt = { decisionId, attemptId: "attempt1", status: "attempting" };
    expect(mailbox.receipt(bridge, attempt).sendAllowed).toBe(true);
    mailbox = new HumanBridgeMailbox(db);
    expect(mailbox.receipt(bridge, attempt).sendAllowed).toBe(false);
    expect(mailbox.inbox(bridge).pending[0]).toMatchObject({ deliveryStatus: "indeterminate", retryAllowed: false });
    mailbox.receipt(bridge, { ...attempt, status: "indeterminate" });
    expect(() => mailbox.receipt(bridge, { ...attempt, status: "delivered", chatId: "-123", messageId: "10" })).toThrow();
    mailbox.reconcile(bridge.id, { decisionId, requestId: "manual1", actorSession: actor.session, action: "confirm", chatId: "-123", messageId: "10" });
    expect(mailbox.inbox(bridge).pending).toEqual([]);
  });
  it("deduplicates bridge creation and rejects changed payloads or unauthorized destinations", async () => {
    const body = { requestId: "tg--123-10", qitemId: "tg--123-10", destinationSession: "builder@agency-sites", body: "Do it" };
    expect(prepareBridgeCreate(db, bridge, body)).toEqual({});
    expect(prepareBridgeCreate(db, bridge, body)).toEqual({});
    expect(() => prepareBridgeCreate(db, bridge, { ...body, body: "Different" })).toThrow();
    expect(() => prepareBridgeCreate(db, bridge, { ...body, destinationSession: "operator-agent@kernel" })).toThrow();
  });
  it("blocks remote writes, forged local headers, and bridge privilege escalation before handlers", async () => {
    const a = app(), body = JSON.stringify({ sourceSession: "human@kernel", destinationSession: "builder@agency-sites", body: "Do it" });
    for (const headers of [{}, { Host: "127.0.0.1:7433", "X-Forwarded-For": "127.0.0.1", "X-OpenRig-Session": "human@kernel" }]) {
      const r = await a.request("http://daemon/api/queue/create", { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body }); expect(r.status).toBe(401);
    }
    expect((await a.request("http://daemon/api/queue/x/update", { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{}" })).status).toBe(403);
    expect((await a.request("http://daemon/api/bridge/inbox")).status).toBe(401);
    expect((await a.request("http://daemon/api/bridge/inbox", { headers: { Authorization: `Bearer ${token}` } })).status).toBe(200);
    expect(db.prepare("SELECT count(*) AS n FROM queue_items").get()).toEqual({ n: 0 });
    await expect(assertBindAuthInvariant({ host: "100.114.220.73", bearerToken: null })).rejects.toThrow();
  });
  it("answers through HTTP using the credential identity and creates only one continuation", async () => {
    const q = await ask(), a = app();
    const body = { requestId: "tg-123-10", expectedRevision: q.revision, actorSession: "operator-agent@kernel", answers: { q1: "yes", q2: "no" } };
    const send = () => a.request(`/api/queue/${q.qitemId}/answer`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-OpenRig-Session": "operator-agent@kernel" }, body: JSON.stringify(body) });
    const results = await Promise.all([send(), send()]);
    expect(results.map(r => r.status)).toEqual([200, 200]);
    expect(await results[0]!.json()).toEqual(await results[1]!.json());
    expect(queue.getById(q.qitemId)?.humanAnswers).toEqual({ q1: "yes", q2: "no" });
    expect(db.prepare("SELECT source_session FROM queue_items WHERE json_extract(tags, '$[0]') = 'human-answer'").all()).toEqual([{ source_session: actor.session }]);
  });
  it("creates through HTTP with a stable ID and refuses payload changes", async () => {
    const a = app(), body = { requestId: "tg-123-20", qitemId: "tg-123-20", sourceSession: "operator-agent@kernel", destinationSession: "builder@agency-sites", body: "Task", nudge: false };
    const send = (input = body) => a.request("/api/queue/create", { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(input) });
    const first = await send(), replay = await send();
    expect(first.status).toBe(201); expect(replay.status).toBe(201);
    expect(await replay.json()).toEqual(await first.json());
    expect(queue.getById(body.qitemId)?.sourceSession).toBe(actor.session);
    expect((await send({ ...body, body: "Changed" })).status).toBe(409);
  });
  it("retains withdrawal when later changes belong to another recipient", async () => {
    const q = await ask(), mailbox = new HumanBridgeMailbox(db), first = mailbox.inbox(bridge);
    db.prepare("UPDATE queue_items SET destination_session = ? WHERE qitem_id = ?").run("other@external", q.qitemId);
    db.prepare("UPDATE queue_items SET body = ? WHERE qitem_id = ?").run("Private change", q.qitemId);
    const events = mailbox.inbox(bridge, first.cursor).events;
    expect(events).toHaveLength(1); expect(events[0]?.type).toBe("withdrawn");
    expect(events[0]?.qitem).not.toHaveProperty("body");
    const snapshot = mailbox.inbox(bridge);
    expect(snapshot.pending.filter(p => p.type !== "withdrawn")).toEqual([]);
  });
  it("blocks a revised card while an older delivery is uncertain", async () => {
    const q = await ask(), mailbox = new HumanBridgeMailbox(db), first = mailbox.inbox(bridge);
    const oldId = first.events[0]!.decisionId;
    mailbox.receipt(bridge, { decisionId: oldId, attemptId: "attempt1", status: "attempting" });
    queue.recordHumanAnswer({ qitemId: q.qitemId, actorSession: "human@kernel", questionId: "q1", optionId: "yes" });
    const revised = mailbox.inbox(bridge, first.cursor).events[0]!;
    expect(revised.retryAllowed).toBe(false);
    mailbox.reconcile(bridge.id, { decisionId: oldId, requestId: "manual-retry", actorSession: actor.session, action: "retry" });
    expect(mailbox.inbox(bridge).pending.find(p => p.decisionId === revised.decisionId)?.retryAllowed).toBe(true);
  });
  it("accepts terminal query credentials only on terminal routes", async () => {
    const a = new Hono();
    a.use("*", networkWriteAuth({ home, operatorTokens: ["operator"], terminalToken: "terminal", activityHookToken: "hook", peerAddress: () => "100.114.220.73" }));
    a.get("/api/terminal/x", c => c.json({ ok: true })); a.post("/api/admin", c => c.json({ ok: true }));
    a.post("/api/activity/hooks", c => c.json({ ok: true }));
    expect((await a.request("/api/terminal/x?token=terminal", { headers: { Upgrade: "websocket" } })).status).toBe(200);
    expect((await a.request("/api/admin", { method: "POST", headers: { Authorization: "Bearer terminal" } })).status).toBe(401);
    expect((await a.request("/api/activity/hooks", { method: "POST", headers: { Authorization: "Bearer hook" } })).status).toBe(200);
    expect((await a.request("/api/admin", { method: "POST", headers: { Authorization: "Bearer hook" } })).status).toBe(401);
  });
  it("reports Hermes readiness from polling and delivery evidence, independently of Slack", async () => {
    app(); await ask(); const mailbox = new HumanBridgeMailbox(db);
    expect(resolveHermesReadiness(home, db, human).state).toBe("not-ready");
    const decisionId = mailbox.inbox(bridge).events[0]!.decisionId;
    expect(resolveHermesReadiness(home, db, human).state).toBe("indeterminate");
    mailbox.receipt(bridge, { decisionId, attemptId: "attempt1", status: "attempting" });
    mailbox.receipt(bridge, { decisionId, attemptId: "attempt1", status: "delivered", chatId: "123", messageId: "10" });
    expect(resolveHermesReadiness(home, db, human).state).toBe("ready");
    expect(resolveHermesReadiness(home, db, human, new Date(Date.now() + 91_000)).state).toBe("not-ready");
    writeFileSync(join(home, "gateway", "bridges", "hermes.json"), JSON.stringify({ ...bridge, enabled: false }));
    expect(resolveHermesReadiness(home, db, human)).toMatchObject({ configured: true, enabled: false, active: false, state: "not-ready" });
  });
  it("allows a new attempt after a definite failure and returns saved card coordinates", async () => {
    const q = await ask(), mailbox = new HumanBridgeMailbox(db);
    const decisionId = mailbox.inbox(bridge).events[0]!.decisionId;
    const first = { decisionId, attemptId: "attempt1", status: "attempting" };
    mailbox.receipt(bridge, first); mailbox.receipt(bridge, { ...first, status: "failed" });
    expect(mailbox.inbox(bridge).pending[0]?.retryAllowed).toBe(true);
    expect(mailbox.receipt(bridge, first).sendAllowed).toBe(false);
    const next = { ...first, attemptId: "attempt2" };
    expect(mailbox.receipt(bridge, next).sendAllowed).toBe(true);
    mailbox.receipt(bridge, { ...next, status: "delivered", chatId: "123", messageId: "10" });
    queue.recordHumanAnswer({ qitemId: q.qitemId, actorSession: "human@kernel", questionId: "q1", optionId: "yes" });
    expect(mailbox.inbox(bridge).events[0]?.message).toEqual({ chatId: "123", messageId: "10" });
  });
  it("refuses a stale delivery reservation even before the next inbox poll", async () => {
    const q = await ask(), mailbox = new HumanBridgeMailbox(db);
    const decisionId = mailbox.inbox(bridge).events[0]!.decisionId;
    queue.recordHumanAnswer({ qitemId: q.qitemId, actorSession: "human@kernel", questionId: "q1", optionId: "yes" });
    expect(mailbox.receipt(bridge, { decisionId, attemptId: "attempt1", status: "attempting" })).toMatchObject({ status: "superseded", sendAllowed: false });
  });
  it("uses the actual loopback HTTP socket peer and refuses an unknown peer", async () => {
    const a = new Hono(); let writes = 0;
    a.use("*", networkWriteAuth({ home, operatorTokens: ["operator-test-token"] }));
    a.post("/write", c => { writes++; return c.json({ ok: true }, 201); });
    const server = serve({ fetch: a.fetch, hostname: "0.0.0.0", port: 0 });
    if (!server.listening) await once(server, "listening");
    const port = (server.address() as { port: number }).port;
    try {
      expect((await fetch(`http://127.0.0.1:${port}/write`, { method: "POST" })).status).toBe(201);
      expect((await a.fetch(new Request("http://fixture/write", { method: "POST" }), {})).status).toBe(401);
      expect(writes).toBe(1);
    } finally { await new Promise<void>((resolve, reject) => server.close(e => e ? reject(e) : resolve())); }
  });
  it.each([false, true])("routes Slack text through the common decision service (structured=%s)", async structured => {
    const q = await ask(structured);
    db.prepare("UPDATE queue_items SET destination_session = ? WHERE qitem_id = ?").run(actor.session, q.qitemId);
    const create = vi.fn(), acknowledge = vi.fn();
    const router = new InboundRouter({ queue: { createQitem: create },
      seen: new SeenStore(join(home, "slack-seen.jsonl")), deadLetter: new DeadLetterStore(join(home, "slack-dead.jsonl")),
      destination: "builder@agency-sites", resolveSender: () => ({ admitted: true, source: actor.session }),
      resolveRoute: () => ({ destination: "builder@agency-sites", correlationQitemId: q.qitemId }),
      acknowledgeAnswer: acknowledge,
      answerHumanDecision: input => service.answer(input.qitemId, { session: input.actorSession, scope: "slack" }, { requestId: input.requestId, decision: input.decision }),
    });
    const result = await router.route({ type: "message", user: "U1", channel: "C1", ts: "100.2", thread_ts: "100.1", text: "Decisão humana" });
    expect(result.landed).toBe(true); expect(create).not.toHaveBeenCalled();
    if (structured) { expect(acknowledge).toHaveBeenCalled(); expect(queue.getById(q.qitemId)?.state).toBe("pending"); }
    else expect(queue.getById(q.qitemId)?.state).toBe("done");
  });
});
