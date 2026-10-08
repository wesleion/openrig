import { createHash } from "node:crypto";
import type Database from "better-sqlite3";
import type { QueueRepository } from "./queue-repository.js";
import { formatHumanAnswers, unansweredQuestions } from "./human-questions.js";
import { askedHumanMatches } from "./gateway/human-bridge-config.js";

export class HumanDecisionError extends Error {
  constructor(public readonly code: string, public readonly httpStatus: number, message: string) { super(message); }
}
export interface HumanDecisionInput {
  requestId: string;
  expectedRevision?: number;
  answers?: Record<string, string>;
  decision?: string;
}
export interface HumanDecisionActor { session: string; scope: string; aliases?: readonly string[] }
export interface HumanDecisionResult {
  qitemId: string; complete: boolean; revision: number;
  answers: Record<string, string>; remainingQuestions: string[];
  status: "partial" | "resolved";
}
interface DecisionRow { scope: string; request_id: string; digest: string; qitem_id: string; actor_session: string; input: string; state: string; result: string }

export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
  return JSON.stringify(value);
}

export class HumanDecisionService {
  private readonly inflight = new Map<string, Promise<HumanDecisionResult>>();
  constructor(private readonly db: Database.Database, private readonly queue: QueueRepository,
    private readonly resolveReply: (input: { qitemId: string; actorSession: string; decision: string }) => Promise<"resolved" | "already-resolved" | "not-applicable">) {}

  revision(qitemId: string): number {
    const row = this.db.prepare("SELECT human_revision FROM queue_items WHERE qitem_id = ?").get(qitemId) as { human_revision: number } | undefined;
    if (!row) throw new HumanDecisionError("qitem_not_found", 404, "Queue item not found");
    return row.human_revision;
  }

  async answer(qitemId: string, actor: HumanDecisionActor, input: HumanDecisionInput): Promise<HumanDecisionResult> {
    if (!input || typeof input.requestId !== "string" || !input.requestId.trim() || input.requestId.length > 240 ||
        (input.expectedRevision !== undefined && (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1)) ||
        (input.answers !== undefined && (!input.answers || Array.isArray(input.answers) || typeof input.answers !== "object" || Object.values(input.answers).some(v => typeof v !== "string"))) ||
        (input.decision !== undefined && (typeof input.decision !== "string" || input.decision.length > 64000))) {
      throw new HumanDecisionError("invalid_decision", 400, "A requestId, valid revision, and answer IDs or decision text are required");
    }
    const digest = createHash("sha256").update(canonicalJson({ qitemId, actor: actor.session, input })).digest("hex");
    const row = this.db.transaction(() => {
      const prior = this.db.prepare("SELECT * FROM human_decisions WHERE scope = ? AND request_id = ?").get(actor.scope, input.requestId) as DecisionRow | undefined;
      if (prior) {
        if (prior.digest !== digest) throw new HumanDecisionError("request_id_conflict", 409, "The requestId was already used with a different payload");
        return prior;
      }
      if (this.db.prepare("SELECT 1 FROM human_decisions WHERE qitem_id = ? AND state = 'recorded'").get(qitemId)) {
        throw new HumanDecisionError("decision_in_progress", 409, "Another accepted decision is being completed");
      }
      const item = this.queue.getById(qitemId);
      if (!item) throw new HumanDecisionError("qitem_not_found", 404, "Queue item not found");
      const blockedHuman = item.state === "blocked" && askedHumanMatches(item.blockedOn ?? "", actor.session, actor.aliases);
      if (!blockedHuman && !askedHumanMatches(item.destinationSession, actor.session, actor.aliases)) throw new HumanDecisionError("not_the_asked_human", 403, "This request was addressed to another human");
      if (item.humanIntent === "update") throw new HumanDecisionError("not_a_decision", 409, "An update does not request a decision");
      if (item.state !== "pending" && !blockedHuman) throw new HumanDecisionError("decision_closed", 409, `The request is ${item.state}`);
      if (input.expectedRevision !== undefined && this.revision(qitemId) !== input.expectedRevision) throw new HumanDecisionError("revision_conflict", 409, "Reload the revised request before answering");
      const questions = item.humanQuestions ?? [];
      const selected = Object.entries(input.answers ?? {});
      if (selected.length && input.decision !== undefined) throw new HumanDecisionError("mixed_decision_modes", 400, "Use option IDs or free-text decision, not both");
      if (questions.length) {
        if (!selected.length) throw new HumanDecisionError("answer_ids_required", 400, "Structured questions require question and option IDs");
        for (const [questionId, optionId] of selected) {
          const q = questions.find(q => q.id === questionId);
          if (!q?.options.some(o => o.id === optionId)) throw new HumanDecisionError("unknown_option", 400, "Unknown question or option ID");
          if (unansweredQuestions(questions, item.humanAnswers ?? {}).length === 0 && item.humanAnswers?.[questionId] !== optionId) throw new HumanDecisionError("answer_conflict", 409, "The completed decision cannot be replaced");
          const r = this.queue.recordHumanAnswer({ qitemId, actorSession: item.destinationSession, questionId, optionId });
          if (r.status !== "recorded") throw new HumanDecisionError("answer_not_recorded", 409, r.reason);
        }
      } else if (selected.length || !input.decision?.trim()) {
        throw new HumanDecisionError("decision_text_required", 400, "A free-text decision requires non-empty decision text and no option IDs");
      }
      const fresh = this.queue.getById(qitemId)!;
      const remaining = unansweredQuestions(questions, fresh.humanAnswers ?? {});
      const complete = !remaining.length;
      const result: HumanDecisionResult = { qitemId, complete, revision: this.revision(qitemId), answers: fresh.humanAnswers ?? {}, remainingQuestions: remaining.map(q => q.id), status: complete ? "resolved" : "partial" };
      const decision = questions.length ? formatHumanAnswers(questions, result.answers).join("; ") : input.decision!.trim();
      const stored = JSON.stringify({ actor, decision, recordedRevision: result.revision, sourceSession: blockedHuman ? fresh.destinationSession : fresh.sourceSession, blockedHuman });
      this.db.prepare("INSERT INTO human_decisions(scope, request_id, digest, qitem_id, actor_session, input, state, result) VALUES(?, ?, ?, ?, ?, ?, ?, ?)")
        .run(actor.scope, input.requestId, digest, qitemId, actor.session, stored, complete ? "recorded" : "partial", JSON.stringify(result));
      return this.db.prepare("SELECT * FROM human_decisions WHERE scope = ? AND request_id = ?").get(actor.scope, input.requestId) as DecisionRow;
    })();
    if (row.state === "partial" || row.state === "complete") return JSON.parse(row.result) as HumanDecisionResult;
    if (row.state === "superseded") throw new HumanDecisionError("decision_superseded", 409, "This decision was superseded or canceled");
    const key = canonicalJson([row.scope, row.request_id]);
    const active = this.inflight.get(key);
    if (active) return active;
    const promise = this.finish(row).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }

  private async finish(row: DecisionRow): Promise<HumanDecisionResult> {
    const data = JSON.parse(row.input) as { actor: HumanDecisionActor; decision: string; recordedRevision: number; sourceSession: string; blockedHuman?: boolean };
    const item = this.queue.getById(row.qitem_id);
    const wasResolved = this.queue.transitionLog.listForQitem(row.qitem_id).some(t => t.ownerNotificationKind === "human-decision-resolved");
    if (!wasResolved && (!item || item.state !== (data.blockedHuman ? "blocked" : "pending") || this.revision(row.qitem_id) !== data.recordedRevision)) {
      this.db.prepare("UPDATE human_decisions SET state = 'superseded' WHERE scope = ? AND request_id = ?").run(row.scope, row.request_id);
      throw new HumanDecisionError("decision_superseded", 409, "The request changed or closed before continuation");
    }
    if (!wasResolved) {
      const continuationId = `qitem-human-answer-${createHash("sha256").update(row.qitem_id).digest("hex").slice(0,24)}`;
      await this.queue.create({ qitemId: continuationId, sourceSession: row.actor_session, destinationSession: data.sourceSession,
        body: `${data.decision}\n\nIn reply to: ${row.qitem_id}`, summary: "Human decision received", tags: ["human-answer"], identityProvenance: "transport:v1" });
      const resolved = data.blockedHuman ? "not-applicable" : await this.resolveReply({ qitemId: row.qitem_id, actorSession: row.actor_session, decision: data.decision });
      if (resolved === "not-applicable") {
        // Legacy local human seats are admitted only by the explicit alias validated above.
        const current = this.queue.getById(row.qitem_id);
        const addressed = current && (data.blockedHuman
          ? current.state === "blocked" && askedHumanMatches(current.blockedOn ?? "", data.actor.session, data.actor.aliases)
          : current.state === "pending" && !current.blockedOn && askedHumanMatches(current.destinationSession, data.actor.session, data.actor.aliases));
        if (!addressed) throw new HumanDecisionError("resolve_not_applicable", 409, "The request could not be resolved");
        this.queue.update({ qitemId: row.qitem_id, actorSession: row.actor_session, state: "done", closureReason: "no-follow-on", transitionNote: data.decision, ownerNotificationKind: "human-decision-resolved" });
      }
    }
    const result = { ...JSON.parse(row.result), revision: this.revision(row.qitem_id), status: "resolved" } as HumanDecisionResult;
    this.db.prepare("UPDATE human_decisions SET state = 'complete', result = ? WHERE scope = ? AND request_id = ?").run(JSON.stringify(result), row.scope, row.request_id);
    return result;
  }

  async recover(): Promise<void> {
    const rows = this.db.prepare("SELECT * FROM human_decisions WHERE state = 'recorded'").all() as DecisionRow[];
    for (const row of rows) { try { await this.finish(row); } catch { /* Durable row remains retryable, or is explicitly superseded. */ } }
  }
}
