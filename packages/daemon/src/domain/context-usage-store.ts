import Database from "better-sqlite3";
import { isAbsolute, join } from "node:path";
import os from "node:os";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { resolveCodexDbPaths } from "./codex-thread-id.js";
import { readNativeCodexObservation, readCodexCatalogDefault, type CodexTokenCountEvent, type NativeCodexObservation } from "./native-codex-observation.js";
import { readClaudeRuntimeMetadata } from "./native-claude-metadata.js";
import type { ContextUsage, ContextUnknownReason } from "./types.js";
import { parseSqliteUtcMs } from "./sqlite-time.js";
import {
  contextUsageDirectory,
  legacyContextUsageDirectory,
  telemetrySidecarPath,
} from "./telemetry-state-paths.js";

/** Freshness threshold: samples older than this are considered stale for compact displays. */
export const FRESHNESS_THRESHOLD_MS = 600_000; // 10 minutes per PM spec

export interface ContextUsageStoreOpts {
  stateDir: string;
  codexHomeDir?: string | null;
  /** Explicit CODEX_HOME. codexHomeDir above is the legacy OS-home input. */
  codexHome?: string;
  // GHOST-STAGE (c-id): resolve the LIVE occupant's boot time (atom-B tenure) for a node, so a
  // reading sampled BEFORE the current occupant booted (a prior generation) is rejected instead of
  // driving the threshold. null = UNKNOWN → the gate is inert (note-2).
  resolveOccupantBootAt?: (nodeId: string) => string | null;
  resolveOccupantGeneration?: (nodeId: string) => string | null;
}

interface SidecarRaw {
  model?: { id?: unknown; display_name?: unknown };
  context_window?: {
    context_window_size?: number;
    used_percentage?: number;
    remaining_percentage?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    current_usage?: unknown;
  };
  session_id?: string;
  session_name?: string;
  /** Managed seat generation inherited by the status-line collector. Lets consumers distinguish
   *  a canonical occupant from a retained predecessor whose launch-time --name aliases the seat. */
  occupant_generation?: string;
  transcript_path?: string;
  sampled_at?: string;
}

interface ContextUsageRow {
  node_id: string;
  session_id: string | null;
  session_name: string | null;
  availability: string;
  reason: string | null;
  source: string | null;
  used_percentage: number | null;
  remaining_percentage: number | null;
  context_window_size: number | null;
  total_input_tokens: number | null;
  total_output_tokens: number | null;
  current_usage: string | null;
  transcript_path: string | null;
  sampled_at: string | null;
  updated_at: string;
}

interface CodexThreadRow {
  id: string;
  rollout_path: string;
}

import { SessionRenewalStore, currentContextInput } from "./session-renewal-store.js";

export class ContextUsageStore {
  private readonly verifiedCodexGenerations = new WeakMap<ContextUsage, string>();
  readonly db: Database.Database;
  private stateDir: string;
  private codexHomeDir: string | null;
  private codexHome?: string;

  private readonly resolveOccupantBootAt?: (nodeId: string) => string | null;
  private readonly resolveOccupantGeneration?: (nodeId: string) => string | null;
  constructor(db: Database.Database, opts: ContextUsageStoreOpts) {
    this.db = db;
    this.stateDir = opts.stateDir;
    this.codexHomeDir = opts.codexHomeDir ?? safeHomeDir();
    this.codexHome = opts.codexHome;
    this.resolveOccupantBootAt = opts.resolveOccupantBootAt;
    this.resolveOccupantGeneration = opts.resolveOccupantGeneration;
  }

  /**
   * GHOST-STAGE (c-id): is this reading from a generation PRIOR to the node's live occupant?
   * A reading sampled strictly before the current occupant booted belongs to a retired tenure
   * (the frozen-88% specimen in the mixed-gen window after handover, where the name is reused so
   * session_mismatch cannot catch it). Returns false when boot time is UNKNOWN or the reading has
   * no sampled_at — the gate is inert (note-2: never treat unknown as stale), leaving
   * session_mismatch + freshness as the remaining guards. boot_at is SQLite datetime('now') (UTC,
   * no zone marker), so it is parsed as UTC; a bare Date.parse would read it as local time.
   */
  private isPriorGenerationReading(nodeId: string, sampledAt: string | null): boolean {
    if (!sampledAt) return false;
    const bootAt = this.resolveOccupantBootAt?.(nodeId) ?? null;
    if (!bootAt) return false;
    const sampled = Date.parse(sampledAt);
    const boot = parseSqliteUtcMs(bootAt);
    if (Number.isNaN(sampled) || Number.isNaN(boot)) return false;
    return sampled < boot;
  }

  /** Get the sidecar file path for a session. */
  getSidecarPath(sessionName: string): string {
    return telemetrySidecarPath(contextUsageDirectory(this.stateDir), sessionName);
  }

  /**
   * GHOST-STAGE (e) Class-A 2a: remove a retiring occupant's name-keyed context sidecar so a
   * same-name successor does not read the predecessor's frozen telemetry sample (the "gen-1 88%
   * resurfaced as a live threshold flag" specimen). Safe by TIMING — the cutover seam
   * (OccupantInvalidator) calls this inside SeatHandoverService.commit(), BEFORE the successor
   * writes its own sidecar. Missing file = no-op; best-effort (a leftover is caught downstream by
   * the freshness gate). NOTE: this is the DISK sidecar (name-keyed); the context_usage DB table is
   * node_id-keyed + already session_mismatch-gated, so it needs no invalidation here.
   */
  invalidateOccupantSidecar(sessionName: string): void {
    const filePath = this.getSidecarPath(sessionName);
    try {
      if (existsSync(filePath)) unlinkSync(filePath);
    } catch {
      /* best-effort — a stale leftover is still gated by isFresh downstream */
    }
  }

  /** Read and parse a sidecar JSON file. Returns discriminated result. */
  readSidecar(sessionName: string): { ok: true; data: SidecarRaw } | { ok: false; reason: "missing_sidecar" | "parse_error" } {
    const canonical = this.readSidecarAt(this.getSidecarPath(sessionName));
    if (canonical.ok || canonical.reason !== "missing_sidecar") return canonical;
    return this.readSidecarAt(
      telemetrySidecarPath(legacyContextUsageDirectory(this.stateDir), sessionName),
    );
  }

  private readSidecarAt(filePath: string): { ok: true; data: SidecarRaw } | { ok: false; reason: "missing_sidecar" | "parse_error" } {
    try {
      if (!existsSync(filePath)) return { ok: false, reason: "missing_sidecar" };
      const content = readFileSync(filePath, "utf-8");
      const parsed = JSON.parse(content) as SidecarRaw;
      return { ok: true, data: parsed };
    } catch {
      return { ok: false, reason: "parse_error" };
    }
  }

  /** Read sidecar and normalize into ContextUsage in one step. */
  readAndNormalize(sessionName: string): ContextUsage {
    const result = this.readSidecar(sessionName);
    if (!result.ok) return this.unknownUsage(result.reason);
    return this.normalizeSample(result.data);
  }

  /** Read the latest Codex token_count event for a thread and normalize it. */
  readCodexAndNormalize(input: { threadId: string | null | undefined; sessionName: string; codexHome?: string; verifiedGeneration?: string }): ContextUsage {
    const threadId = input.threadId?.trim();
    if (!threadId) return this.unknownUsage("no_data");

    const thread = this.readCodexThread(threadId, input.codexHome);
    if (!thread?.rollout_path) return this.unknownUsage("no_data");

    const observation = readNativeCodexObservation(thread.rollout_path);
    if (observation.runtimeMetadata.effort === "default" && input.codexHome) {
      const catalog = readCodexCatalogDefault(input.codexHome, observation.runtimeMetadata.model);
      if (catalog) {
        observation.runtimeMetadata.effortDefault = catalog.effort;
        observation.runtimeMetadata.effortDefaultSampledAt = catalog.sampledAt;
      }
    }
    const tokenEvent = observation.tokenCount;
    const normalized = !tokenEvent ? { ...this.unknownUsage("no_data"), transcriptPath: thread.rollout_path,
      sessionId: threadId, sessionName: input.sessionName, execution: observation.execution, runtimeMetadata: observation.runtimeMetadata }
      : this.normalizeCodexTokenCount({
      event: tokenEvent,
      sessionName: input.sessionName,
      threadId,
      transcriptPath: thread.rollout_path,
      observation,
    });
    // Explicit roots and UUIDs come only from the monitor's verified live-process join.
    // Preserve the native event time: adoption/resume does not create a fresh inference.
    if (input.codexHome && input.verifiedGeneration?.trim()) {
      this.verifiedCodexGenerations.set(normalized, input.verifiedGeneration);
    }
    return normalized;
  }

  /** Resolve an explicitly selected native thread, even before its first token count. */
  readCodexTranscriptPath(threadId: string, codexHome?: string): string | null {
    return this.readCodexThread(threadId, codexHome)?.rollout_path ?? null;
  }

  /** Normalize raw sidecar data into a ContextUsage record. */
  normalizeSample(raw: SidecarRaw | null): ContextUsage {
    if (!raw) {
      return this.unknownUsage("missing_sidecar");
    }

    const cw = raw.context_window;
    if (!cw || typeof cw.used_percentage !== "number") {
      return this.unknownUsage("parse_error");
    }

    const sampledAt = raw.sampled_at ?? null;
    const fresh = sampledAt ? this.isFresh(sampledAt) : false;
    const transcriptMetadata = readClaudeRuntimeMetadata(raw.transcript_path, raw.session_id);
    const statusModel = typeof raw.model?.id === "string" && raw.model.id.trim() ? raw.model.id.trim() : null;
    const runtimeMetadata = statusModel ? {
      model: statusModel,
      effort: transcriptMetadata?.model === statusModel ? transcriptMetadata.effort : null,
      sampledAt,
      source: transcriptMetadata?.model === statusModel && transcriptMetadata.effort
        ? "claude_statusline_and_transcript" : "claude_statusline_json",
    } : transcriptMetadata;

    return {
      availability: "known",
      reason: null,
      source: "claude_statusline_json",
      usedPercentage: cw.used_percentage ?? null,
      remainingPercentage: cw.remaining_percentage ?? null,
      contextWindowSize: cw.context_window_size ?? null,
      totalInputTokens: cw.total_input_tokens ?? null,
      totalOutputTokens: cw.total_output_tokens ?? null,
      currentUsage: this.normalizeCurrentUsage(cw.current_usage),
      transcriptPath: raw.transcript_path ?? null,
      sessionId: raw.session_id ?? null,
      sessionName: raw.session_name ?? null,
      sampledAt,
      fresh,
      // Rendering a statusline is not an inference. Only the native response clock ages the cache.
      ...this.claudeInference(cw.current_usage, transcriptMetadata?.sampledAt ?? null),
      ...(runtimeMetadata ? { runtimeMetadata } : {}),
    };
  }

  /** Normalize a Codex token_count JSONL event into ContextUsage. */
  private normalizeCodexTokenCount(input: {
    event: CodexTokenCountEvent;
    sessionName: string;
    threadId: string;
    transcriptPath: string;
    observation: NativeCodexObservation;
  }): ContextUsage {
    const info = input.event.payload?.info;
    const usage = info?.last_token_usage;
    const cumulative = info?.total_token_usage;
    const contextWindowSize = info?.model_context_window;

    if (!usage || (usage.input_tokens === undefined && usage.output_tokens === undefined && usage.total_tokens === undefined)
      || typeof contextWindowSize !== "number" || contextWindowSize <= 0) {
      return { ...this.unknownUsage("parse_error"), transcriptPath: input.transcriptPath,
        sessionId: input.threadId, sessionName: input.sessionName,
        execution: input.observation.execution, runtimeMetadata: input.observation.runtimeMetadata };
    }

    const inputTokens = typeof usage.input_tokens === "number" ? usage.input_tokens : null;
    const outputTokens = typeof usage.output_tokens === "number" ? usage.output_tokens : null;
    const totalTokens = typeof usage.total_tokens === "number"
      ? usage.total_tokens
      : (inputTokens ?? 0) + (outputTokens ?? 0);
    const usedPercentage = clampPercentage(Math.round((totalTokens / contextWindowSize) * 100));
    const remainingPercentage = clampPercentage(100 - usedPercentage);
    const sampledAt = input.event.timestamp ?? null;

    return {
      availability: "known",
      reason: null,
      source: "codex_token_count_jsonl",
      usedPercentage,
      remainingPercentage,
      contextWindowSize,
      totalInputTokens: cumulative?.input_tokens ?? null,
      totalOutputTokens: cumulative?.output_tokens ?? null,
      totalCachedInputTokens: cumulative?.cached_input_tokens ?? null,
      lastInference: { inputTokens, outputTokens, cachedInputTokens: usage.cached_input_tokens ?? null,
        totalTokens, at: sampledAt },
      execution: input.observation.execution,
      runtimeMetadata: input.observation.runtimeMetadata,
      currentUsage: this.normalizeCurrentUsage({
        last_token_usage: usage,
        total_token_usage: cumulative,
        model_context_window: contextWindowSize,
      }),
      transcriptPath: input.transcriptPath,
      sessionId: input.threadId,
      sessionName: input.sessionName,
      sampledAt,
      fresh: sampledAt ? this.isFresh(sampledAt) : false,
    };
  }

  /** Persist a context usage record for a node. Upserts. */
  persist(nodeId: string, usage: ContextUsage): void {
    this.db.prepare(`
      INSERT INTO context_usage (
        node_id, session_id, session_name, availability, reason, source,
        used_percentage, remaining_percentage, context_window_size,
        total_input_tokens, total_output_tokens, current_usage,
        transcript_path, sampled_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
      ON CONFLICT(node_id) DO UPDATE SET
        session_id = excluded.session_id,
        session_name = excluded.session_name,
        availability = excluded.availability,
        reason = excluded.reason,
        source = excluded.source,
        used_percentage = excluded.used_percentage,
        remaining_percentage = excluded.remaining_percentage,
        context_window_size = excluded.context_window_size,
        total_input_tokens = excluded.total_input_tokens,
        total_output_tokens = excluded.total_output_tokens,
        current_usage = excluded.current_usage,
        transcript_path = excluded.transcript_path,
        sampled_at = excluded.sampled_at,
        updated_at = datetime('now')
    `).run(
      nodeId,
      usage.sessionId,
      usage.sessionName,
      usage.availability,
      usage.reason,
      usage.source,
      usage.usedPercentage,
      usage.remainingPercentage,
      usage.contextWindowSize,
      usage.totalInputTokens,
      usage.totalOutputTokens,
      this.packUsage(usage),
      usage.transcriptPath,
      usage.sampledAt,
    );
    new SessionRenewalStore(this.db).observeBaseline(nodeId, usage);
  }

  /** Get context usage for a single node. Session-aware: mismatched session returns unknown. */
  getForNode(nodeId: string, currentSessionName: string | null): ContextUsage {
    if (!currentSessionName) return this.unknownUsage("not_managed");

    const row = this.db.prepare("SELECT * FROM context_usage WHERE node_id = ?").get(nodeId) as ContextUsageRow | undefined;
    if (!row) return this.unknownUsage("no_data");

    // Session mismatch guard: prevent stale cross-session inheritance
    if (row.session_name && row.session_name !== currentSessionName) {
      return this.unknownUsage("session_mismatch");
    }

    // GHOST-STAGE (c-id): generation guard. Under handover the name is REUSED, so session_mismatch
    // passes while the table still holds the retiree's pre-boot reading (the mixed-gen window).
    // Reject readings from before the live occupant booted → insufficient-data, evaluate current-gen only.
    const verifiedGeneration = this.codexGenerationVerdict(nodeId, row);
    if (verifiedGeneration === "mismatch" || (this.isPriorGenerationReading(nodeId, row.sampled_at) && verifiedGeneration !== "match")) {
      return this.unknownUsage("stale_generation");
    }

    return this.withRenewal(nodeId, this.rowToUsage(row));
  }

  /** Batch get context usage for multiple nodes. Session-aware per entry. */
  getForNodes(entries: Array<{ nodeId: string; currentSessionName: string | null }>): Map<string, ContextUsage> {
    const result = new Map<string, ContextUsage>();
    if (entries.length === 0) return result;

    const nodeIds = entries.map((e) => e.nodeId);
    const sessionMap = new Map(entries.map((e) => [e.nodeId, e.currentSessionName]));

    const rows = this.db.prepare(
      `SELECT * FROM context_usage WHERE node_id IN (${nodeIds.map(() => "?").join(",")})`
    ).all(...nodeIds) as ContextUsageRow[];

    const rowMap = new Map(rows.map((r) => [r.node_id, r]));

    for (const entry of entries) {
      if (!entry.currentSessionName) {
        result.set(entry.nodeId, this.unknownUsage("not_managed"));
        continue;
      }

      const row = rowMap.get(entry.nodeId);
      if (!row) {
        result.set(entry.nodeId, this.unknownUsage("no_data"));
        continue;
      }

      if (row.session_name && row.session_name !== entry.currentSessionName) {
        result.set(entry.nodeId, this.unknownUsage("session_mismatch"));
        continue;
      }

      // GHOST-STAGE (c-id): generation guard — see getForNode. Reject pre-boot (prior-gen) readings.
      const verifiedGeneration = this.codexGenerationVerdict(entry.nodeId, row);
      if (verifiedGeneration === "mismatch" || (this.isPriorGenerationReading(entry.nodeId, row.sampled_at) && verifiedGeneration !== "match")) {
        result.set(entry.nodeId, this.unknownUsage("stale_generation"));
        continue;
      }

      result.set(entry.nodeId, this.withRenewal(entry.nodeId, this.rowToUsage(row)));
    }

    return result;
  }

  /** Create an unknown ContextUsage with an honest reason. */
  unknownUsage(reason: ContextUnknownReason): ContextUsage {
    return {
      availability: "unknown",
      reason,
      source: null,
      usedPercentage: null,
      remainingPercentage: null,
      contextWindowSize: null,
      totalInputTokens: null,
      totalOutputTokens: null,
      currentUsage: null,
      transcriptPath: null,
      sessionId: null,
      sessionName: null,
      sampledAt: null,
      fresh: false,
    };
  }

  /** Check if a sample timestamp is fresh. */
  private isFresh(sampledAt: string): boolean {
    try {
      const age = Date.now() - new Date(sampledAt).getTime();
      return age >= 0 && age < FRESHNESS_THRESHOLD_MS;
    } catch {
      return false;
    }
  }

  /** Convert a DB row to a ContextUsage, applying freshness. */
  private rowToUsage(row: ContextUsageRow): ContextUsage {
    const fresh = row.sampled_at ? this.isFresh(row.sampled_at) : false;
    return {
      availability: row.availability as ContextUsage["availability"],
      reason: row.reason as ContextUsage["reason"],
      source: row.source as ContextUsage["source"],
      usedPercentage: row.used_percentage,
      remainingPercentage: row.remaining_percentage,
      contextWindowSize: row.context_window_size,
      totalInputTokens: row.total_input_tokens,
      totalOutputTokens: row.total_output_tokens,
      ...this.unpackUsage(row.current_usage),
      transcriptPath: row.transcript_path,
      sessionId: row.session_id,
      sessionName: row.session_name,
      sampledAt: row.sampled_at,
      fresh,
    };
  }

  private normalizeCurrentUsage(value: unknown): string | null {
    if (value == null) return null;
    if (typeof value === "string") return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }

  private claudeInference(value: unknown, at: string | null): Pick<ContextUsage, "lastInference"> {
    let raw = value;
    if (typeof raw === "string") { try { raw = JSON.parse(raw); } catch { return {}; } }
    if (!raw || typeof raw !== "object") return {};
    const record = raw as Record<string, unknown>;
    const number = (name: string): number | null => typeof record[name] === "number"
      && Number.isFinite(record[name]) && record[name] >= 0 ? record[name] : null;
    const inputTokens = number("input_tokens");
    const outputTokens = number("output_tokens");
    const cachedInputTokens = number("cache_read_input_tokens");
    const cacheCreation = number("cache_creation_input_tokens");
    if (inputTokens === null && outputTokens === null && cachedInputTokens === null) return {};
    return { lastInference: { inputTokens, outputTokens, cachedInputTokens, cacheCreationInputTokens: cacheCreation,
      totalTokens: inputTokens !== null && outputTokens !== null
        ? inputTokens + outputTokens + (cachedInputTokens ?? 0) + (cacheCreation ?? 0) : null, at } };
  }

  /** Store typed additions without altering the legacy currentUsage response contract. */
  private packUsage(usage: ContextUsage): string | null {
    const verifiedCodexGeneration = this.verifiedCodexGenerations.get(usage);
    if (usage.lastInference === undefined && usage.totalCachedInputTokens === undefined
      && usage.execution === undefined && usage.runtimeMetadata === undefined && !verifiedCodexGeneration) return usage.currentUsage;
    return JSON.stringify({ $openrigContextUsage: 1, currentUsage: usage.currentUsage,
      lastInference: usage.lastInference, totalCachedInputTokens: usage.totalCachedInputTokens,
      execution: usage.execution, runtimeMetadata: usage.runtimeMetadata, verifiedCodexGeneration });
  }

  private codexGenerationVerdict(nodeId: string, row: ContextUsageRow): "match" | "mismatch" | "unverified" {
    if (!this.resolveOccupantGeneration || !row.current_usage) return "unverified";
    try {
      const envelope = JSON.parse(row.current_usage);
      if (envelope?.$openrigContextUsage !== 1 || typeof envelope.verifiedCodexGeneration !== "string") return "unverified";
      const current = this.resolveOccupantGeneration(nodeId);
      return current && envelope.verifiedCodexGeneration === current ? "match" : "mismatch";
    } catch { return "unverified"; }
  }

  private unpackUsage(value: string | null): Pick<ContextUsage, "currentUsage" | "lastInference" | "totalCachedInputTokens" | "execution" | "runtimeMetadata"> {
    if (value) {
      try {
        const envelope = JSON.parse(value);
        if (envelope && envelope.$openrigContextUsage === 1) {
          return { currentUsage: typeof envelope.currentUsage === "string" ? envelope.currentUsage : null,
            ...(envelope.lastInference !== undefined ? { lastInference: envelope.lastInference } : {}),
            ...(envelope.totalCachedInputTokens !== undefined ? { totalCachedInputTokens: envelope.totalCachedInputTokens } : {}),
            ...(envelope.execution !== undefined ? { execution: envelope.execution } : {}),
            ...(envelope.runtimeMetadata !== undefined ? { runtimeMetadata: envelope.runtimeMetadata } : {}) };
        }
      } catch { /* Old opaque payloads remain readable. */ }
    }
    return { currentUsage: value };
  }

  private withRenewal(nodeId: string, usage: ContextUsage): ContextUsage {
    const store = new SessionRenewalStore(this.db);
    if (!store.available()) return usage;
    const context = currentContextInput(usage);
    return { ...usage, baselineInputTokens: store.baseline(nodeId, usage),
      contextInputTokens: context?.tokens ?? null, contextInputSource: context?.source ?? null };
  }

  private readCodexThread(threadId: string, codexHome?: string): CodexThreadRow | null {
    for (const dbPath of this.resolveCodexStateDbPaths(codexHome)) {
      try {
        const codexDb = new Database(dbPath, { readonly: true });
        try {
          const row = codexDb.prepare(
            "SELECT id, rollout_path FROM threads WHERE id = ? LIMIT 1",
          ).get(threadId) as CodexThreadRow | undefined;
          if (row?.rollout_path) return row;
        } finally {
          codexDb.close();
        }
      } catch {
        continue;
      }
    }
    return null;
  }

  private resolveCodexStateDbPaths(codexHome?: string): string[] {
    if (codexHome !== undefined && (!codexHome || !isAbsolute(codexHome))) return [];
    const selectedHome = codexHome ?? this.codexHome;
    return selectedHome || this.codexHomeDir ? resolveCodexDbPaths(this.codexHomeDir ?? "", "state", undefined, selectedHome) : [];
  }

}

function clampPercentage(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

function safeHomeDir(): string | null {
  try {
    return os.homedir();
  } catch {
    return null;
  }
}
