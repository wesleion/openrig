import type Database from "better-sqlite3";
import { accountScopedInferenceAt } from "./provider/account-cache-scope.js";
import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import type { ContextUsage } from "./types.js";

export interface SessionRenewalPolicy {
  enabled: boolean;
  cacheTtlMinutes: number;
  usedTokensMargin: number;
}
export type SessionRenewalOverride = Partial<SessionRenewalPolicy>;
export const DEFAULT_SESSION_RENEWAL: SessionRenewalPolicy = {
  enabled: false, cacheTtlMinutes: 60, usedTokensMargin: 30_000,
};

export function validateSessionRenewal(value: unknown, where: string): string[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [`${where}: must be an object`];
  const p = value as Record<string, unknown>;
  const errors = Object.keys(p).filter(k => !["enabled", "cacheTtlMinutes", "usedTokensMargin"].includes(k))
    .map(k => `${where}.${k}: unsupported key`);
  if (p.enabled !== undefined && typeof p.enabled !== "boolean") errors.push(`${where}.enabled: must be boolean`);
  for (const key of ["cacheTtlMinutes", "usedTokensMargin"] as const) {
    if (p[key] !== undefined && (!Number.isSafeInteger(p[key]) || (p[key] as number) <= 0)) {
      errors.push(`${where}.${key}: must be a positive integer`);
    }
  }
  return errors;
}

function number(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Input size, not accumulated billing. Codex cache reads are already included in input_tokens. */
export function currentContextInput(usage: ContextUsage): { tokens: number; source: "native" | "estimate" } | null {
  if (usage.availability !== "known") return null;
  const inference = usage.lastInference;
  const input = number(inference?.inputTokens);
  if (input !== null) {
    if (usage.source === "codex_token_count_jsonl") return { tokens: input, source: "native" };
    if (usage.source === "claude_statusline_json") {
      const read = number(inference?.cachedInputTokens);
      const creation = number(inference?.cacheCreationInputTokens);
      if (read !== null && creation !== null) return { tokens: input + read + creation, source: "native" };
      // Old envelopes retained creation only in totalTokens; output must be known to subtract it.
      const total = number(inference?.totalTokens), output = number(inference?.outputTokens);
      if (total !== null && output !== null && total >= output) return { tokens: total - output, source: "native" };
    }
  }
  const percentage = number(usage.usedPercentage), window = number(usage.contextWindowSize);
  return percentage !== null && percentage <= 100 && window !== null && window > 0
    ? { tokens: Math.round(percentage * window / 100), source: "estimate" } : null;
}

/** Read from the beginning, bounded. A tail alone cannot prove which inference was first. */
export function readFirstNativeInput(usage: ContextUsage, startupAt: string): { tokens: number; at: string } | null {
  if (!usage.transcriptPath || !usage.sessionId || !Number.isFinite(Date.parse(startupAt))) return null;
  let fd: number | undefined;
  try {
    fd = openSync(usage.transcriptPath, "r");
    const size = fstatSync(fd).size;
    const length = Math.min(size, 2_000_000);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, 0);
    let text = buffer.toString("utf8");
    if (size > length) text = text.slice(0, text.lastIndexOf("\n"));
    let codexSession: string | null = null;
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      let record: any;
      try { record = JSON.parse(line); } catch { return null; }
      if (record.type === "session_meta") codexSession = record.payload?.id ?? null;
      const at = typeof record.timestamp === "string" ? record.timestamp : null;
      if (!at || !Number.isFinite(Date.parse(at)) || Date.parse(at) < Date.parse(startupAt)) continue;
      if (usage.source === "codex_token_count_jsonl" && record.type === "event_msg"
        && record.payload?.type === "token_count" && codexSession === usage.sessionId) {
        const tokens = number(record.payload.info?.last_token_usage?.input_tokens);
        if (tokens !== null && tokens > 0) return { tokens, at };
      }
      if (usage.source === "claude_statusline_json" && record.type === "assistant" && record.sessionId === usage.sessionId
        && record.message?.role === "assistant" && record.message?.model && record.message.model !== "<synthetic>") {
        const raw = record.message?.usage;
        const input = number(raw?.input_tokens), read = number(raw?.cache_read_input_tokens), creation = number(raw?.cache_creation_input_tokens);
        if (input !== null && read !== null && creation !== null && input + read + creation > 0) return { tokens: input + read + creation, at };
      }
    }
  } catch { return null; } finally { if (fd !== undefined) closeSync(fd); }
  return null;
}

export class SessionRenewalStore {
  constructor(readonly db: Database.Database) {}

  available(): boolean {
    return !!this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='session_renewals'").get();
  }

  policy(nodeId: string): SessionRenewalPolicy {
    if (!this.available()) return { ...DEFAULT_SESSION_RENEWAL };
    const row = this.db.prepare(`SELECT n.session_renewal_json seat, r.session_renewal_json rig
      FROM nodes n JOIN rigs r ON r.id=n.rig_id WHERE n.id=?`).get(nodeId) as { seat: string | null; rig: string | null } | undefined;
    try {
      const rig = row?.rig ? JSON.parse(row.rig) : {}, seat = row?.seat ? JSON.parse(row.seat) : {};
      if (validateSessionRenewal(rig, "rig").length || validateSessionRenewal(seat, "seat").length) return { ...DEFAULT_SESSION_RENEWAL };
      return { ...DEFAULT_SESSION_RENEWAL, ...rig, ...seat };
    } catch { return { ...DEFAULT_SESSION_RENEWAL }; }
  }

  baseline(nodeId: string, usage: ContextUsage): number | null {
    if (!this.available() || !usage.sessionId || !usage.source) return null;
    const row = this.db.prepare(`SELECT input_tokens FROM session_renewal_baselines
      WHERE node_id=? AND runtime=? AND session_id=?`).get(nodeId, usage.source, usage.sessionId) as { input_tokens: number } | undefined;
    return row?.input_tokens ?? null;
  }

  observeBaseline(nodeId: string, usage: ContextUsage): void {
    if (!this.available() || usage.availability !== "known" || !usage.sessionId || !usage.source || this.baseline(nodeId, usage) !== null) return;
    const session = this.db.prepare(`SELECT startup_completed_at FROM sessions
      WHERE node_id=? AND session_name=? AND status='running' ORDER BY id DESC LIMIT 1`)
      .get(nodeId, usage.sessionName) as { startup_completed_at: string | null } | undefined;
    if (!session?.startup_completed_at) return;
    const first = readFirstNativeInput(usage, session.startup_completed_at);
    if (!first) return;
    this.db.prepare(`INSERT OR IGNORE INTO session_renewal_baselines
      (node_id,runtime,session_id,input_tokens,inference_at) VALUES (?,?,?,?,?)`)
      .run(nodeId, usage.source, usage.sessionId, first.tokens, first.at);
  }

  episode(nodeId: string, episodeId: string): any | null {
    if (!this.available()) return null;
    const row = this.db.prepare("SELECT record_json FROM session_renewals WHERE node_id=? AND episode_id=?")
      .get(nodeId, episodeId) as { record_json: string } | undefined;
    return row ? JSON.parse(row.record_json) : null;
  }

  record(nodeId: string, episodeId: string, qitemId: string, record: Record<string, unknown>, insertOnly = false): boolean {
    const sql = insertOnly ? `INSERT OR IGNORE INTO session_renewals (node_id,episode_id,qitem_id,state,record_json,updated_at) VALUES (?,?,?,?,?,?)`
      : `INSERT INTO session_renewals (node_id,episode_id,qitem_id,state,record_json,updated_at) VALUES (?,?,?,?,?,?)
         ON CONFLICT(node_id,episode_id) DO UPDATE SET state=excluded.state,record_json=excluded.record_json,updated_at=excluded.updated_at`;
    return this.db.prepare(sql).run(nodeId, episodeId, qitemId, String(record.state), JSON.stringify(record), String(record.at)).changes > 0;
  }

  view(nodeId: string, usage: ContextUsage, now = Date.now()): {
    cache: { idleMinutes: number | null; warmEstimate: boolean | null };
    renewal: { policy: SessionRenewalPolicy; last: any | null };
  } {
    const policy = this.policy(nodeId);
    const at = accountScopedInferenceAt(this.db, nodeId, usage.lastInference?.at);
    const age = at ? now - Date.parse(at) : NaN;
    const idleMinutes = Number.isFinite(age) && age >= 0 ? age / 60_000 : null;
    const row = this.available() ? this.db.prepare("SELECT record_json FROM session_renewals WHERE node_id=? ORDER BY updated_at DESC,rowid DESC LIMIT 1")
      .get(nodeId) as { record_json: string } | undefined : undefined;
    return { cache: { idleMinutes, warmEstimate: idleMinutes === null ? null : idleMinutes <= policy.cacheTtlMinutes },
      renewal: { policy, last: row ? JSON.parse(row.record_json) : null } };
  }
}
