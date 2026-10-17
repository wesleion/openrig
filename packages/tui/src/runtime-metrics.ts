import type { AgentRow } from "./types.js";
import { DEFAULT_TIME_ZONE, displayTime } from "./time.js";

export function reasoningEffortLabel(effort: string | null | undefined, catalogDefault?: string | null): string {
  return effort === "default" ? catalogDefault ? `${catalogDefault}, padrão` : "padrão" : effort ?? "—";
}

export function elapsedMs(at: string | null | undefined, nowMs: number): number | null {
  if (!at || !Number.isFinite(nowMs)) return null;
  const start = Date.parse(at);
  return Number.isFinite(start) && start <= nowMs ? nowMs - start : null;
}

export function elapsedLabel(at: string | null | undefined, nowMs: number): string {
  const age = elapsedMs(at, nowMs);
  if (age == null) return "—";
  const seconds = Math.floor(age / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h${Math.floor(seconds / 60) % 60}m`;
  return `${Math.floor(seconds / 86400)}d${Math.floor(seconds / 3600) % 24}h`;
}

function stateStartedAt(agent: AgentRow): string | null | undefined {
  const execution = agent.contextUsage?.execution;
  if (agent.status === "idle" && execution?.completedAt &&
      (!execution.startedAt || Date.parse(execution.completedAt) >= Date.parse(execution.startedAt))) return execution.completedAt;
  return agent.activityStartedAt ?? agent.activityStateChangedAt;
}

export function stateWithElapsed(agent: AgentRow, word: string, nowMs: number, width: number): string {
  if (agent.nodeKind === "infrastructure") return agent.controller?.mode ?? word;
  if (!["active", "working", "running", "idle"].includes(agent.status)) return word;
  const duration = elapsedLabel(stateStartedAt(agent), nowMs);
  const full = `${word} ${duration}`;
  return full.length <= width ? full : `${word === "working" ? "work" : word} ${duration}`;
}

export function hasRuntimeClock(agent: AgentRow, nowMs: number): boolean {
  return [stateStartedAt(agent), agent.contextUsage?.execution?.completedAt,
    agent.contextUsage?.execution?.lastModelResponseAt].some(at => elapsedMs(at, nowMs) != null);
}

function tokens(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? "—" : value.toLocaleString("en-US");
}

export function runtimeMetricFields(agent: AgentRow, nowMs: number, timeZone = DEFAULT_TIME_ZONE): Array<{ label: string; value: string }> {
  const context = agent.contextUsage;
  const last = context?.lastInference;
  const execution = context?.execution;
  const metadata = agent.runtimeMetadata ?? context?.runtimeMetadata;
  const timestamp = (at: string | null | undefined): string => at && elapsedMs(at, nowMs) != null
    ? `${elapsedLabel(at, nowMs)} · ${displayTime(at, timeZone)}` : "—";
  const model = metadata?.model ?? agent.controller?.model ?? agent.model;
  const effort = metadata?.effort ?? agent.effort;
  return [
    { label: "model", value: `${model ?? "—"}${metadata?.model ? " (observed)" : agent.controller?.model ? " (controller)" : model ? " (declared)" : ""}` },
    { label: "effort", value: agent.nodeKind === "infrastructure" ? "N/A" : `${reasoningEffortLabel(effort, metadata?.effortDefault)}${effort === "default" ? metadata?.effortDefault ? " (catálogo; efetivo não registrado)" : " (nível efetivo não registrado)" : metadata?.effort ? " (observed)" : effort ? " (declared)" : ""}` },
    { label: "last input", value: tokens(last?.inputTokens) },
    { label: "last output", value: tokens(last?.outputTokens) },
    { label: "last cache", value: tokens(last?.cachedInputTokens) },
    { label: "last total", value: tokens(last?.totalTokens) },
    { label: "session in", value: tokens(context?.totalInputTokens ?? agent.totalInputTokens) },
    { label: "session out", value: tokens(context?.totalOutputTokens ?? agent.totalOutputTokens) },
    { label: "session cache", value: tokens(context?.totalCachedInputTokens) },
    { label: "window", value: tokens(context?.contextWindowSize ?? agent.contextWindowSize) },
    { label: "state age", value: elapsedLabel(stateStartedAt(agent), nowMs) },
    { label: "last finish", value: timestamp(execution?.completedAt) },
    { label: "last response", value: timestamp(execution?.lastModelResponseAt) },
    { label: "context src", value: `${context?.source ?? "unknown"}${context?.reason ? ` · ${context.reason}` : ""}${context?.sampledAt ? ` · ${displayTime(context.sampledAt, timeZone)}` : ""}${context?.fresh === false ? " (stale sample)" : ""}` },
    { label: "runtime src", value: `${metadata?.source ?? "unknown"}${metadata?.sampledAt ? ` · ${displayTime(metadata.sampledAt, timeZone)}` : ""}` },
    { label: "time src", value: execution?.source ?? "unknown" },
    { label: "cache basis", value: "Recorded cache tokens show reuse. Idle time alone does not prove cache validity." },
  ];
}
