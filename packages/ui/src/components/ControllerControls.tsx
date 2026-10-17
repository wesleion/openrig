import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { missionControlAuthHeaders } from "./mission-control/missionControlAuth.js";
import { useSelectedHostId } from "../hooks/useHosts.js";
import { LOCAL_HOST_ID } from "../lib/host-param.js";
import { Dialog, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from "./ui/dialog.js";

export interface ControllerView {
  kind: "jev-flow"; config: string; available?: boolean;
  mode?: "off" | "observe" | "apply"; revision?: number; changedAt?: string | null;
  model?: string; modelApplyEnabled?: boolean; error?: string;
  latest?: { status: string; createdAt: string; action: string | null; reason: string | null } | null;
}
export interface NativeContextView {
  availability?: string; reason?: string | null; usedPercentage?: number | null;
  contextWindowSize?: number | null; totalInputTokens?: number | null; totalOutputTokens?: number | null;
  totalCachedInputTokens?: number | null; sampledAt?: string | null; fresh?: boolean;
  lastInference?: { inputTokens: number | null; outputTokens: number | null; cachedInputTokens: number | null; totalTokens: number | null; at: string | null };
  execution?: { startedAt: string | null; completedAt: string | null; lastModelResponseAt: string | null; source: string | null };
  runtimeMetadata?: { model: string | null; effort: string | null; sampledAt: string | null; source: string | null };
}

function validControllerStatus(value: unknown, binding: ControllerView): value is ControllerView {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const body = value as ControllerView;
  return body.kind === "jev-flow" && body.config === binding.config && body.available === true
    && ["off", "observe", "apply"].includes(body.mode ?? "")
    && Number.isSafeInteger(body.revision) && (body.revision ?? -1) >= (binding.revision ?? 0);
}

export function ControllerModeControl({ rigId, nodeId, controller, readOnly = false }: {
  rigId?: string; nodeId?: string; controller?: ControllerView | null; readOnly?: boolean;
}) {
  const queryClient = useQueryClient();
  const remote = useSelectedHostId() !== LOCAL_HOST_ID;
  const [current, setCurrent] = useState(controller);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [requiresRefresh, setRequiresRefresh] = useState(false);
  const identity = `${rigId ?? ""}|${nodeId ?? ""}|${controller?.config ?? ""}`;
  const previousIdentity = useRef(identity);
  const requestGeneration = useRef(0);
  useEffect(() => {
    const changedIdentity = previousIdentity.current !== identity;
    previousIdentity.current = identity;
    if (changedIdentity) { requestGeneration.current++; setBusy(false); setError(null); }
    setCurrent(previous => {
      if (changedIdentity || !controller || !previous || controller.config !== previous.config) return controller;
      if (previous.revision !== undefined && (controller.revision === undefined || controller.revision < previous.revision)) {
        return controller.available === false ? { ...previous, available: false, error: controller.error } : previous;
      }
      return controller;
    });
    if (changedIdentity || (controller?.available === true && Number.isSafeInteger(controller.revision))) setRequiresRefresh(false);
  }, [controller, identity]);
  if (!current) return null;
  const change = async (mode: string) => {
    if (readOnly || remote || busy || requiresRefresh || current.available !== true || !rigId || !nodeId) return;
    const generation = ++requestGeneration.current;
    setBusy(true); setError(null);
    try {
      const response = await fetch(`/api/rigs/${encodeURIComponent(rigId)}/controllers/${encodeURIComponent(nodeId)}`, {
        method: "PATCH", headers: { "Content-Type": "application/json", ...missionControlAuthHeaders() },
        body: JSON.stringify({ mode, expectedRevision: current.revision }), signal: AbortSignal.timeout(10_000),
      });
      const body: unknown = await response.json();
      if (generation !== requestGeneration.current) return;
      if (!response.ok) throw new Error(body && typeof body === "object" && "error" in body ? String(body.error) : `HTTP ${response.status}`);
      if (!validControllerStatus(body, current)) throw new Error("Resposta de estado inválida; atualize antes de alterar o modo.");
      setCurrent(previous => previous?.config === body.config && (previous.revision ?? -1) > (body.revision ?? -1) ? previous : body);
      await queryClient.invalidateQueries({ predicate: q => q.queryKey.some(k => k === rigId) });
    } catch (e) {
      if (generation !== requestGeneration.current) return;
      setError(e instanceof Error ? e.message : "Falha ao alterar modo");
      setRequiresRefresh(true);
      void queryClient.invalidateQueries({ predicate: q => q.queryKey.some(k => k === rigId) });
    }
    finally { if (generation === requestGeneration.current) setBusy(false); }
  };
  return <div className="nodrag nopan space-y-1" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    <label className="block font-mono text-[9px]">Modo do controlador
      <select aria-label="Modo do controlador Jev" value={current.mode ?? ""}
        disabled={readOnly || remote || busy || requiresRefresh || !rigId || !nodeId || current.available !== true}
        onChange={e => { void change(e.target.value); }}
        className="ml-1 border border-outline bg-surface px-1 py-0.5 text-on-surface">
        {!current.mode && <option value="">Indisponível</option>}
        <option value="off">Desligado</option><option value="observe">Observar</option><option value="apply">Aplicar</option>
      </select>
    </label>
    {current.mode === "apply" && !current.modelApplyEnabled && <p className="text-[8px] text-on-surface-variant">Jev observa até aprovação do benchmark.</p>}
    {(error || current.error) && <p role="alert" className="text-[9px] text-red-600">{error ?? current.error}</p>}
  </div>;
}

export function elapsedTime(at: string | null | undefined, now = Date.now()): string {
  const stamp = at ? Date.parse(at) : NaN;
  if (!Number.isFinite(stamp) || stamp > now) return "—";
  const seconds = Math.floor((now - stamp) / 1000);
  if (seconds < 60) return `${seconds}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ${Math.floor(seconds % 3600 / 60)}m`;
  return `${Math.floor(seconds / 86400)}d ${Math.floor(seconds % 86400 / 3600)}h`;
}
const count = (n: number | null | undefined) => typeof n === "number" ? n.toLocaleString("pt-BR") : "—";

export function RuntimeMetricsDetails({ contextUsage: u, activityState: a }: {
  contextUsage?: NativeContextView | null;
  activityState?: { activity?: string; display?: string; changedAt?: string | null; activityStartedAt?: string | null } | null;
}) {
  const [now, setNow] = useState(Date.now);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open]);
  const last = u?.lastInference, execution = u?.execution;
  const idle = a?.display === "idle" || a?.activity === "idle-at-prompt";
  const completion = execution?.completedAt;
  const completedTurn = completion && (!execution?.startedAt || Date.parse(completion) >= Date.parse(execution.startedAt));
  const since = idle && completedTurn ? completion : a?.activityStartedAt ?? a?.changedAt;
  const cacheRatio = last?.inputTokens && last.cachedInputTokens !== null
    ? `${(last.cachedInputTokens / last.inputTokens * 100).toFixed(1)}%` : "—";
  return <div className="nodrag nopan text-[9px] text-on-surface-variant" onClick={e => e.stopPropagation()} onPointerDown={e => e.stopPropagation()}>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild><button type="button" className="cursor-pointer underline underline-offset-2">Contexto e tempo</button></DialogTrigger>
      <DialogContent className="max-h-[80vh] max-w-[440px] overflow-y-auto text-[12px]" onClick={e => e.stopPropagation()}>
        <DialogTitle>Contexto e tempo</DialogTitle>
        <DialogDescription>Cache registrado indica reutilização. Tempo parado não garante validade do cache.</DialogDescription>
    <dl className="mt-1 space-y-1">
      <div><dt className="inline">{idle ? "Parado há" : "Estado há"}: </dt><dd className="inline">{elapsedTime(since, now)}</dd></div>
      <div><dt className="inline">Última execução terminou há: </dt><dd className="inline">{elapsedTime(completion, now)}</dd></div>
      <div><dt className="inline">Última resposta do modelo há: </dt><dd className="inline">{elapsedTime(execution?.lastModelResponseAt ?? last?.at, now)}</dd></div>
      <div><dt className="inline">Contexto: </dt><dd className="inline">{u?.availability === "known" ? `${u.usedPercentage ?? "—"}% / ${count(u.contextWindowSize)} tokens` : `— (${u?.reason ?? "sem dados"})`}</dd></div>
      <div><dt className="inline">Última inferência: </dt><dd className="inline">{count(last?.inputTokens)} entrada / {count(last?.outputTokens)} saída</dd></div>
      <div><dt className="inline">Cache reutilizado na última inferência: </dt><dd className="inline">{count(last?.cachedInputTokens)} ({cacheRatio})</dd></div>
      <div><dt className="inline">Acumulado da sessão: </dt><dd className="inline">{count(u?.totalInputTokens)} entrada / {count(u?.totalOutputTokens)} saída / {count(u?.totalCachedInputTokens)} cache</dd></div>
      <div>Origem: {execution?.source ?? u?.runtimeMetadata?.source ?? "observação de estado"}. Amostra: {u?.sampledAt ?? "—"}.</div>
      {u?.fresh === false && <div>Última amostra preservada; coleta sem atualização recente.</div>}
    </dl>
      </DialogContent>
    </Dialog>
  </div>;
}
