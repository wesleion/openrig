import { missionControlAuthHeaders } from "../components/mission-control/missionControlAuth.js";

interface RigRef { id: string; name: string }
interface NodeRef { nodeId: string; logicalId: string; canonicalSessionName?: string }
type Read = <T>(url: string) => Promise<T>;
const read: Read = async <T>(url: string) => {
  const response = await fetch(url, { headers: missionControlAuthHeaders(), signal: AbortSignal.timeout(10000) });
  if (!response.ok) throw new Error(`Cannot resolve seat navigation: HTTP ${response.status}`);
  return response.json() as Promise<T>;
};

/** Resolve display references through inventory; never select an ambiguous rig or seat. */
export async function resolveSeatRoute(params: { rigId: string; logicalId: string }, request: Read = read) {
  const rigs = await request<RigRef[]>("/api/rigs/summary?includeArchived=true");
  const exact = rigs.find(r => r.id === params.rigId);
  const candidates = exact ? [exact] : rigs.filter(r => r.name === params.rigId);
  if (candidates.length !== 1) throw new Error(candidates.length ? `Ambiguous rig reference: ${params.rigId}` : `Rig not found: ${params.rigId}`);
  const rig = candidates[0]!;
  const nodes = await request<NodeRef[]>(`/api/rigs/${encodeURIComponent(rig.id)}/nodes`);
  const nodeRef = decodeURIComponent(params.logicalId);
  const exactNodes = nodes.filter(n => n.logicalId === nodeRef || n.nodeId === nodeRef);
  const matches = exactNodes.length ? exactNodes : nodes.filter(n => n.canonicalSessionName === (nodeRef.includes("@") ? nodeRef : `${nodeRef}@${rig.name}`));
  if (matches.length !== 1) throw new Error(matches.length ? `Ambiguous seat reference: ${nodeRef}` : `Seat not found: ${nodeRef}`);
  return { rigId: rig.id, logicalId: matches[0]!.logicalId };
}
