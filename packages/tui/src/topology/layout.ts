// SPIKE — deterministic hand-rolled layout for the boxed graph styles.
// Delegation depth ranks nodes into columns (Hatchet reads left→right);
// collaborators pull right of their source; escalates_to is a back-edge and
// never ranks. Everything is derived from the served projection only.
import type { GraphEdge, GraphNode, RigGraph } from "./graph-types.js";
import { statusGlyph, type StatusGlyph } from "./glyphs.js";
import { markText, runtimeMarkSegs } from "./runtime-marks.js";
import { reasoningEffortLabel } from "../runtime-metrics.js";

export interface PlacedNode {
  node: GraphNode;
  glyph: StatusGlyph;
  /** MEMBER-only display title (S19 MR1 — identity stays logicalId in every
   * zone/action; this is display only) */
  title: string;
  /** `● member  63%` and `runtime · ctx%` — the info INSIDE the node */
  nameLine: string;
  metaLine: string;
  metaLines?: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphContainer {
  kind: "rig" | "pod";
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface GraphLayout {
  placed: PlacedNode[];
  byId: Map<string, PlacedNode>;
  edges: GraphEdge[];
  /** R2 HIGH-1: the LOCKED containment hierarchy — the rig container wraps
   * pod containers, pod containers wrap their member agent boxes; renderers
   * MUST draw them (agent-in-pod-in-rig is a visible contract, not metadata) */
  containers: GraphContainer[];
  width: number;
  height: number;
  /** MR8: true when the laid-out extent exceeds the viewport width — the
   * renderer MUST show the honest clipped-content indicator */
  clipped: boolean;
}

export function agentNodes(graph: RigGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.type === "rigNode" && n.data.nodeKind === "agent");
}

/** Display tools beside agents without including tools in agent totals. */
export function displayNodes(graph: RigGraph): GraphNode[] {
  return graph.nodes.filter((n) => n.type === "rigNode"
    && (n.data.nodeKind === "agent" || n.data.nodeKind === "infrastructure"));
}

export function nodeLines(node: GraphNode): { glyph: StatusGlyph; title: string; nameLine: string; metaLine: string; runtimeLine: string; modelLine: string; model: string; effortSuffix: string } {
  const glyph = statusGlyph(node.data);
  const ctx = node.data.contextUsedPercentage;
  // S19 MR1 (§A1): the pod is named ONCE — by its container tab. The card
  // title is the MEMBER-only segment (a confirmed `${pod}.` prefix strips,
  // the navigator's rule; non-prefixed names display unchanged) and the meta
  // drops the pod suffix.
  const pod = node.data.podNamespace;
  const member = pod && node.data.logicalId.startsWith(`${pod}.`)
    ? node.data.logicalId.slice(pod.length + 1)
    : node.data.logicalId;
  const nameLine = `${glyph.glyph} ${member}${glyph.overlay ? `  ${glyph.overlay}` : ""}`;
  const infrastructure = node.data.nodeKind === "infrastructure";
  const model = node.data.runtimeMetadata?.model ?? node.data.controller?.model ?? node.data.model ?? "—";
  const effort = reasoningEffortLabel(node.data.runtimeMetadata?.effort ?? node.data.effort, node.data.runtimeMetadata?.effortDefault);
  const mode = node.data.controller?.mode;
  const modeLabel = mode === "off" ? "Desligado" : mode === "observe" ? "Observar" : mode === "apply" ? "Aplicar" : "—";
  const runtime = markText(runtimeMarkSegs(node.data.runtime));
  const state = node.data.controller ? `modo ${modeLabel}` : ctx == null ? "—" : `${Math.round(ctx)}%`;
  const effortSuffix = infrastructure ? "" : ` (${effort})`;
  const runtimeLine = `${runtime} ${state}`;
  const modelLine = `${model}${effortSuffix}`;
  const metaLine = `${runtimeLine} · ${modelLine}`;
  return { glyph, title: member, nameLine, metaLine, runtimeLine, modelLine, model, effortSuffix };
}

export function fitGraphText(text: string, width: number): string {
  if (width <= 0) return "";
  return text.length <= width ? text : `${text.slice(0, Math.max(0, width - 1))}…`;
}

function rankNodes(agents: GraphNode[], edges: GraphEdge[]): Map<string, number> {
  const rank = new Map<string, number>();
  const delegates = edges.filter((e) => e.label === "delegates_to");
  const hasIncoming = new Set(delegates.map((e) => e.target));
  const roots = agents.filter((n) => !hasIncoming.has(n.id));
  for (const root of roots) rank.set(root.id, 0);
  // relax delegation depth (fixture-scale graphs; bounded passes)
  for (let pass = 0; pass < agents.length; pass++) {
    let changed = false;
    for (const e of delegates) {
      const from = rank.get(e.source);
      if (from == null) continue;
      const proposed = from + 1;
      if ((rank.get(e.target) ?? -1) < proposed) {
        rank.set(e.target, proposed);
        changed = true;
      }
    }
    if (!changed) break;
  }
  // collaborators sit one column RIGHT of their partner (the mockup reading:
  // lead → driver ═ qa) — applies to nodes that are not delegation targets
  // themselves, even if the root-default provisionally ranked them 0
  for (const e of edges.filter((x) => x.label === "collaborates_with")) {
    const from = rank.get(e.source);
    const targetIsDelegate = delegates.some((d) => d.target === e.target);
    const targetDelegates = delegates.some((d) => d.source === e.target);
    if (from != null && !targetIsDelegate && !targetDelegates) rank.set(e.target, from + 1);
  }
  for (const n of agents) if (!rank.has(n.id)) rank.set(n.id, 0);
  return rank;
}

const POD_GAP = 4;
const MARGIN_X = 1;

/** Pods preserve containment and order, wrapping onto new rows when the viewport is narrow.
 * Card metadata uses another line when necessary; the existing vertical scroll serves tall rigs. */
export function layoutGraph(graph: RigGraph, maxWidth: number, rigName = ""): GraphLayout {
  const agents = displayNodes(graph);
  const rank = rankNodes(agents, graph.edges);
  const podLabel = new Map<string, string>(
    graph.nodes.filter((n) => n.type === "podGroup").map((n) => [n.id, n.data.podNamespace ?? n.data.logicalId]),
  );
  const pods = new Map<string, GraphNode[]>();
  for (const n of agents) {
    const key = (n.parentId && podLabel.get(n.parentId)) ?? n.data.podNamespace ?? "(no pod)";
    pods.set(key, [...(pods.get(key) ?? []), n]);
  }
  const podOrder = [...pods.entries()].sort(([an, a], [bn, b]) => {
    const ar = Math.min(...a.map((n) => rank.get(n.id) ?? 0));
    const br = Math.min(...b.map((n) => rank.get(n.id) ?? 0));
    return ar - br || an.localeCompare(bn);
  });

  const placed: PlacedNode[] = [];
  const byId = new Map<string, PlacedNode>();
  const containers: GraphContainer[] = [];
  const rigX = MARGIN_X;
  const rigY = 1;
  let podX = rigX + 2;
  let podTop = rigY + 1;
  let rowBottom = podTop;
  let maxPodBottom = 0;
  let maxPodRight = podX;
  const availablePodWidth = Math.max(26, Math.floor(maxWidth) - 6);
  for (const [podName, members] of podOrder) {
    const sorted = [...members].sort(
      (a, b) => (rank.get(a.id) ?? 0) - (rank.get(b.id) ?? 0) || a.data.logicalId.localeCompare(b.data.logicalId),
    );
    const naturalPodWidth = Math.max(12, ` ≡ ${podName} `.length + 3,
      ...sorted.map(node => {
        const lines = nodeLines(node);
        return Math.max(lines.nameLine.length, lines.metaLine.length) + 8;
      }));
    const podW = Math.min(naturalPodWidth, availablePodWidth);
    if (podX > rigX + 2 && podX + podW + 3 > maxWidth) {
      podX = rigX + 2;
      podTop = rowBottom + 2;
    }
    let y = podTop + 1;
    for (const node of sorted) {
      const lines = nodeLines(node);
      const w = Math.min(Math.max(lines.nameLine.length, lines.metaLine.length) + 4, podW - 4);
      const textWidth = w - 4;
      const metaLines = lines.metaLine.length <= textWidth ? [lines.metaLine] : [
        fitGraphText(lines.runtimeLine, textWidth),
        `${fitGraphText(lines.model, textWidth - lines.effortSuffix.length)}${lines.effortSuffix}`,
      ];
      const title = fitGraphText(lines.title, w - 6 - (lines.glyph.overlay ? lines.glyph.overlay.length + 2 : 0));
      const p: PlacedNode = { node, glyph: lines.glyph, title, nameLine: lines.nameLine,
        metaLine: lines.metaLine, metaLines, x: podX + 2, y, w, h: metaLines.length + 3 };
      placed.push(p);
      byId.set(node.id, p);
      y += p.h + 1;
    }
    const podH = y - podTop + 1;
    containers.push({ kind: "pod", name: podName, x: podX, y: podTop, w: podW, h: podH });
    maxPodBottom = Math.max(maxPodBottom, podTop + podH);
    rowBottom = Math.max(rowBottom, podTop + podH);
    maxPodRight = Math.max(maxPodRight, podX + podW);
    podX += podW + POD_GAP;
  }
  const rigW = maxPodRight + 2 - rigX;
  // two spare interior rows: the escalation under-route corridor (lanes 0-1)
  // must never land on the rig's own bottom border
  const rigH = maxPodBottom - rigY + 4;
  containers.unshift({ kind: "rig", name: rigName, x: rigX, y: rigY, w: rigW, h: rigH });

  const trueWidth = rigX + rigW + MARGIN_X;
  const width = Math.min(trueWidth, maxWidth);
  const height = rigY + rigH + 1;
  return { placed, byId, edges: graph.edges, containers, width, height, clipped: trueWidth > maxWidth };
}
