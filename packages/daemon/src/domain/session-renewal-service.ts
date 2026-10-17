import type Database from "better-sqlite3";
import { accountScopedInferenceAt } from "./provider/account-cache-scope.js";
import { createHash } from "node:crypto";
import type { ContextUsage } from "./types.js";
import { SessionRenewalStore, currentContextInput } from "./session-renewal-store.js";

export interface RenewalSeat {
  nodeId: string; sessionName: string; generation: string | null;
  usage: ContextUsage; idle: boolean; protected: boolean; ready: boolean;
}
export interface RenewalDeps {
  db: Database.Database;
  resolve: (destination: string) => { nodeId: string; sessionName: string } | null;
  inspect: (nodeId: string) => Promise<RenewalSeat | null>;
  verifyRecipient: (nodeId: string) => Promise<string | null>;
  handover: (seat: RenewalSeat, mode: "fresh" | "rebuild", beforeReplacement: () => Promise<boolean>) => Promise<{ ok: boolean; detail?: string }>;
  exclusive: <T>(nodeId: string, fn: () => Promise<T>) => Promise<T>;
  escalate: (qitemId: string, nodeId: string, episodeId: string) => Promise<void>;
  audit?: (nodeId: string, record: Record<string, unknown>) => void;
  now?: () => Date;
}

/** The decision belongs to an obligation delivery, not to each ladder retry or daemon boot. */
export class SessionRenewalService {
  private readonly store: SessionRenewalStore;
  constructor(private readonly deps: RenewalDeps) { this.store = new SessionRenewalStore(deps.db); }

  async beforeWake(qitemId: string, destination: string): Promise<{ ok: boolean; destination?: string; reason?: string }> {
    if (!this.store.available()) return { ok: true };
    const target = this.deps.resolve(destination);
    if (!target || !this.store.policy(target.nodeId).enabled) return { ok: true };
    try {
      return await this.deps.exclusive(target.nodeId, () => this.prepare(qitemId, destination, target.nodeId));
    } catch (error) {
      // A typing guard or failed lease acquisition occurs before replacement; transport keeps its own guard.
      const episode = this.episode(qitemId, target.nodeId);
      const saved = episode && this.store.episode(target.nodeId, episode.id);
      if (saved?.state === "started" || saved?.state === "failed") {
        return this.reconcile(qitemId, target.nodeId, episode!.id, saved);
      }
      return { ok: true };
    }
  }

  private episode(qitemId: string, nodeId: string): { id: string; item: any } | null {
    const item = this.deps.db.prepare("SELECT * FROM queue_items WHERE qitem_id=?").get(qitemId) as any;
    if (!item) return null;
    const transition = this.deps.db.prepare(`SELECT transition_id FROM queue_transitions
      WHERE qitem_id=? AND state='pending' ORDER BY transition_id DESC LIMIT 1`).get(qitemId) as { transition_id: number } | undefined;
    const id = createHash("sha256").update(JSON.stringify([qitemId, nodeId, transition?.transition_id ?? 0, item.human_answers ?? null])).digest("hex");
    return { id, item };
  }

  private async prepare(qitemId: string, destination: string, nodeId: string): Promise<{ ok: boolean; destination?: string; reason?: string }> {
    const episode = this.episode(qitemId, nodeId);
    if (!episode) return { ok: true };
    const saved = this.store.episode(nodeId, episode.id);
    if (saved) {
      if (saved.state === "started" || saved.state === "failed" || saved.state === "renewed") {
        return this.reconcile(qitemId, nodeId, episode.id, saved);
      }
      return { ok: true };
    }
    const policy = this.store.policy(nodeId);
    const seat = await this.deps.inspect(nodeId);
    const context = seat ? currentContextInput(seat.usage) : null;
    const baseline = seat ? this.store.baseline(nodeId, seat.usage) : null;
    const now = (this.deps.now ?? (() => new Date()))();
    const inferenceAt = accountScopedInferenceAt(this.deps.db, nodeId, seat?.usage.lastInference?.at);
    const age = inferenceAt ? (now.getTime() - Date.parse(inferenceAt)) / 60_000 : NaN;
    const owned = this.deps.db.prepare("SELECT 1 FROM queue_items WHERE destination_session IN (?,?) AND state='in-progress' LIMIT 1")
      .get(destination, seat?.sessionName ?? destination);
    const mode = this.mode(episode.item, destination, seat?.sessionName ?? destination);
    const record: Record<string, unknown> = { qitemId, episodeId: episode.id, at: now.toISOString(),
      cacheAgeMinutes: Number.isFinite(age) && age >= 0 ? age : null,
      contextInputTokens: context?.tokens ?? null, contextInputSource: context?.source ?? null,
      baselineInputTokens: baseline, mode, fromSessionId: seat?.usage.sessionId ?? null,
      fromGeneration: seat?.generation ?? null, policy };
    const skip = !policy.enabled ? "disabled" : !seat?.ready ? "session_not_ready" : seat.protected ? "typing_guard"
      : !seat.idle ? "activity_not_idle" : owned || episode.item.state === "in-progress" ? "in_progress"
      : !context || seat.usage.availability !== "known" || !seat.usage.sessionId ? "context_unknown"
      : baseline === null ? "baseline_unknown" : !Number.isFinite(age) || age < 0 ? "cache_age_unknown"
      : age <= policy.cacheTtlMinutes ? "cache_warm" : context.tokens - baseline <= policy.usedTokensMargin ? "context_small"
      : mode === null ? "lineage_unknown" : null;
    if (skip) {
      this.write(nodeId, episode.id, qitemId, { ...record, state: "skipped", transition: `renewal-skipped:${skip}` }, true);
      return { ok: true };
    }
    // CAS is durable BEFORE the first possible replacement. Recovery never calls handover again.
    if (!this.write(nodeId, episode.id, qitemId, { ...record, state: "started", transition: "renewal-started" }, true)) {
      return this.reconcile(qitemId, nodeId, episode.id, this.store.episode(nodeId, episode.id));
    }
    let ok = false, detail = "handover_failed";
    try {
      const result = await this.deps.handover(seat!, mode!, async () => {
        const current = await this.deps.inspect(nodeId);
        const still = this.episode(qitemId, nodeId);
        const working = this.deps.db.prepare("SELECT 1 FROM queue_items WHERE destination_session IN (?,?) AND state='in-progress' LIMIT 1")
          .get(destination, current?.sessionName ?? destination);
        return !!current?.ready && current.idle && !current.protected && !working
          && current.generation === seat!.generation && current.usage.sessionId === seat!.usage.sessionId
          && still?.id === episode.id && still.item.state !== "in-progress" && this.store.policy(nodeId).enabled;
      });
      ok = result.ok; detail = result.detail ?? detail;
    } catch (error) { detail = (error as Error).message; }
    const recipient = await this.deps.verifyRecipient(nodeId).catch(() => null);
    this.write(nodeId, episode.id, qitemId, { ...record, at: (this.deps.now ?? (() => new Date()))().toISOString(),
      state: ok && recipient ? "renewed" : "failed", transition: ok && recipient ? "renewed-before-delivery" : "renewal-failed",
      destinationVerified: recipient !== null, ...(ok && recipient ? {} : { detail }) });
    if (recipient) return { ok: true, destination: recipient };
    await this.deps.escalate(qitemId, nodeId, episode.id);
    return { ok: false, reason: "renewal_destination_unverified" };
  }

  private async reconcile(qitemId: string, nodeId: string, episodeId: string, record: any): Promise<{ ok: boolean; destination?: string; reason?: string }> {
    const recipient = await this.deps.verifyRecipient(nodeId).catch(() => null);
    if (record?.state === "started") {
      this.write(nodeId, episodeId, qitemId, { ...record, state: "failed", transition: "renewal-failed",
        detail: "daemon_restart_or_uncertain_operation; replacement was not repeated", destinationVerified: recipient !== null,
        at: (this.deps.now ?? (() => new Date()))().toISOString() });
    }
    if (recipient) return { ok: true, destination: recipient };
    await this.deps.escalate(qitemId, nodeId, episodeId);
    return { ok: false, reason: "renewal_destination_unverified" };
  }

  private mode(item: any, destination: string, sessionName: string): "fresh" | "rebuild" | null {
    if (item.claimed_at || item.human_answers && item.human_answers !== "{}") return "rebuild";
    let chain: unknown;
    try { chain = item.chain_of_record ? JSON.parse(item.chain_of_record) : []; } catch { return null; }
    if (!Array.isArray(chain) || chain.some(id => typeof id !== "string")) return null;
    for (const id of chain) {
      const prior = this.deps.db.prepare("SELECT source_session,destination_session,claimed_at,state FROM queue_items WHERE qitem_id=?").get(id) as any;
      if (!prior) return null;
      if ([destination, sessionName].includes(prior.source_session)
        || [destination, sessionName].includes(prior.destination_session) && (prior.claimed_at || ["done", "handed-off"].includes(prior.state))) return "rebuild";
    }
    return "fresh";
  }

  private write(nodeId: string, episodeId: string, qitemId: string, record: Record<string, unknown>, insertOnly = false): boolean {
    const written = this.store.record(nodeId, episodeId, qitemId, record, insertOnly);
    if (written) this.deps.audit?.(nodeId, record);
    return written;
  }
}
