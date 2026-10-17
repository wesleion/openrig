import { closeSync, fstatSync, openSync, readSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { isAbsolute, join } from "node:path";
import type { ContextUsage } from "./types.js";

const execFileAsync = promisify(execFile);
const homeCache = new Map<string, { startTicks: string; home: string }>();

/** The selected account's native model default, not an observed concrete per-turn effort. */
export function readCodexCatalogDefault(codexHome: string, model: string | null): { effort: string; sampledAt: string | null } | null {
  if (!isAbsolute(codexHome) || !model) return null;
  let fd: number;
  try { fd = openSync(join(codexHome, "models_cache.json"), "r"); } catch { return null; }
  try {
    const size = fstatSync(fd).size;
    if (size <= 0 || size > 2_000_000) return null;
    const bytes = Buffer.alloc(size);
    if (readSync(fd, bytes, 0, size, 0) !== size) return null;
    const cache = JSON.parse(bytes.toString("utf8"));
    if (!Array.isArray(cache.models)) return null;
    const selected = cache.models.find((entry: any) => entry?.slug === model);
    const effort = stringValue(selected?.default_reasoning_level);
    if (!effort || !Array.isArray(selected.supported_reasoning_levels)
      || !selected.supported_reasoning_levels.some((level: any) => level?.effort === effort)) return null;
    return { effort, sampledAt: timestamp(cache.fetched_at) };
  } catch { return null; } finally { closeSync(fd); }
}

function procStartTicks(stat: string): string | null {
  // comm may contain spaces and parentheses; field 22 is index 19 after its final ')'.
  return stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/)[19] ?? null;
}

/** The caller must supply a verified native Codex descendant and its census identity.
 * Never expose the full environment, and never search other accounts on a miss. */
export async function resolveCodexHomeByPid(pid: number, startedAt: string): Promise<string | null> {
  if (process.platform !== "linux" || !Number.isSafeInteger(pid) || pid <= 0 || !startedAt.trim()) return null;
  const key = `${pid}|${startedAt.trim().replace(/\s+/g, " ")}`;
  try {
    const before = procStartTicks(await readFile(`/proc/${pid}/stat`, "utf8"));
    if (!before) return null;
    const cached = homeCache.get(key);
    if (cached?.startTicks === before) {
      const after = procStartTicks(await readFile(`/proc/${pid}/stat`, "utf8"));
      return after === before ? cached.home : null;
    }
    const { stdout } = await execFileAsync("ps", ["-p", String(pid), "-o", "lstart="], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C" },
    });
    if (stdout.trim().replace(/\s+/g, " ") !== startedAt.trim().replace(/\s+/g, " ")) return null;
    const values = (await readFile(`/proc/${pid}/environ`, "utf8")).split("\0");
    const explicit = values.find(value => value.startsWith("CODEX_HOME="));
    const osHome = values.find(value => value.startsWith("HOME="))?.slice(5);
    const home = explicit !== undefined ? explicit.slice(11) : osHome ? join(osHome, ".codex") : null;
    const after = procStartTicks(await readFile(`/proc/${pid}/stat`, "utf8"));
    if (!home || !isAbsolute(home) || after !== before) return null;
    if (homeCache.size >= 256 && !homeCache.has(key)) homeCache.delete(homeCache.keys().next().value!);
    homeCache.set(key, { startTicks: before, home });
    return home;
  } catch {
    return null;
  }
}

export interface CodexTokenUsageRaw {
  input_tokens?: number;
  output_tokens?: number;
  cached_input_tokens?: number;
  total_tokens?: number;
}

export interface CodexTokenCountEvent {
  timestamp?: string;
  payload?: {
    type?: string;
    info?: {
      last_token_usage?: CodexTokenUsageRaw;
      total_token_usage?: CodexTokenUsageRaw;
      model_context_window?: number;
    };
  };
}

export interface NativeCodexObservation {
  tokenCount: CodexTokenCountEvent | null;
  execution: NonNullable<ContextUsage["execution"]>;
  runtimeMetadata: NonNullable<ContextUsage["runtimeMetadata"]>;
}

function timestamp(value: unknown): string | null {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : null;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function tokenUsage(value: unknown): CodexTokenUsageRaw | undefined {
  if (!value || typeof value !== "object") return undefined;
  const raw = value as Record<string, unknown>;
  const result: CodexTokenUsageRaw = {};
  for (const name of ["input_tokens", "output_tokens", "cached_input_tokens", "total_tokens"] as const) {
    if (typeof raw[name] === "number" && Number.isFinite(raw[name]) && raw[name] >= 0) result[name] = raw[name];
  }
  return result;
}

/** Bounded backward windows preserve split metadata records without returning message bodies. */
export function readNativeCodexObservation(rolloutPath: string, maxBytes = 8_000_000): NativeCodexObservation {
  const result: NativeCodexObservation = {
    tokenCount: null,
    execution: { startedAt: null, completedAt: null, lastModelResponseAt: null, source: "codex_rollout_jsonl" },
    runtimeMetadata: { model: null, effort: null, sampledAt: null, source: "codex_rollout_jsonl" },
  };
  if (!Number.isFinite(maxBytes) || maxBytes <= 0) return result;
  let fd: number;
  try { fd = openSync(rolloutPath, "r"); } catch { return result; }
  try {
    const size = fstatSync(fd).size;
    const floor = Math.max(0, size - Math.min(Math.floor(maxBytes), 8_000_000));
    let end = size;
    let metadataFound = false;
    while (end > floor) {
      const start = Math.max(floor, end - 524_288);
      const buffer = Buffer.alloc(end - start);
      readSync(fd, buffer, 0, buffer.length, start);
      const lines = buffer.toString("utf8").split("\n");
      let droppedBytes = 0;
      if (start > 0) { droppedBytes = Buffer.byteLength(lines.shift() ?? "", "utf8"); }
      for (let i = lines.length - 1; i >= 0; i--) {
        const line = lines[i]!;
        if (!/"(?:token_count|task_started|task_complete|turn_context|world_state)"/.test(line)) continue;
        try {
          const record = JSON.parse(line) as { timestamp?: unknown; type?: string; payload?: Record<string, any> };
          const at = timestamp(record.timestamp);
          const payload = record.payload;
          if (!payload) continue;
          if (payload.type === "token_count" && !result.tokenCount && payload.info && typeof payload.info === "object") {
            const info = payload.info;
            result.tokenCount = { ...(at ? { timestamp: at } : {}), payload: { type: "token_count", info: {
              last_token_usage: tokenUsage(info.last_token_usage), total_token_usage: tokenUsage(info.total_token_usage),
              model_context_window: typeof info.model_context_window === "number" && Number.isFinite(info.model_context_window) ? info.model_context_window : undefined,
            } } };
            result.execution.lastModelResponseAt = at;
          }
          if (payload.type === "task_started" && !result.execution.startedAt && at) result.execution.startedAt = at;
          if (payload.type === "task_complete" && !result.execution.completedAt && at) result.execution.completedAt = at;
          if (!metadataFound && (record.type === "turn_context" || record.type === "world_state")) {
            const mode = record.type === "turn_context" ? payload.collaboration_mode : payload.state?.collaboration_mode;
            const model = stringValue(payload.model) ?? stringValue(mode?.model) ?? stringValue(mode?.settings?.model);
            const explicitEffort = stringValue(payload.effort) ?? stringValue(payload.reasoning_effort) ?? stringValue(mode?.settings?.reasoning_effort);
            // A recorded null selects the runtime default; absence remains unknown.
            // Never invent the concrete reasoning level behind that default.
            const defaultEffort = [payload, mode?.settings].some(settings => settings &&
              ["effort", "reasoning_effort"].some(key => Object.hasOwn(settings, key) && settings[key] === null));
            const effort = explicitEffort ?? (defaultEffort ? "default" : null);
            if (model || effort) {
              result.runtimeMetadata = { model, effort, sampledAt: at, source: "codex_rollout_jsonl" };
              metadataFound = true;
            }
          }
        } catch { /* A partial or corrupt record cannot establish a native fact. */ }
      }
      if (result.tokenCount && result.execution.startedAt && result.execution.completedAt && metadataFound) break;
      if (start === floor) break;
      const next = start + droppedBytes + 1;
      end = next < end ? next : start;
    }
  } catch { /* Unreadable tails retain honest missing fields. */ } finally { closeSync(fd); }
  return result;
}
