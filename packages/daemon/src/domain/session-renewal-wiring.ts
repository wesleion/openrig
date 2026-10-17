import type { AppDeps } from "../server.js";
import { confirmRenewalRecipient } from "./session-renewal-recipient.js";
import { SettingsStore } from "./user-settings/settings-store.js";
import { OPENRIG_HOME } from "../openrig-compat.js";
import { SessionRenewalService } from "./session-renewal-service.js";
import { SeatHandoverService } from "./seat-handover-service.js";
import { classifyPaneActivity } from "./session-transport.js";
import { buildRebuildPrimingChain } from "./rebuild-priming-chain.js";
import { resolveAuthoredRecapPointer } from "./context-packs/seat-recap-store.js";
import { makePredecessorRecapResolver } from "./predecessor-recap-resolver.js";
import { observeClaudePaneStartedAt } from "./native-process-lineage.js";

/** Use the daemon's existing adapters, identities and lifecycle lease; no HTTP operator impersonation. */
export function wireSessionRenewal(deps: AppDeps, provider?: { beforeWake(id: string, destination: string): Promise<{ ok: boolean; reason?: string }> }): void {
  const { rigRepo, sessionRegistry, tmuxAdapter, contextUsageStore, queueRepo } = deps;
  const db = rigRepo.db;
  const guard = tmuxAdapter.deliveryGuard;
  if (!guard || !contextUsageStore || !queueRepo) return;
  const session = (nodeId: string) => db.prepare(`SELECT s.*,n.runtime,n.rig_id FROM sessions s
    JOIN nodes n ON n.id=s.node_id WHERE s.node_id=? AND s.status='running' ORDER BY s.id DESC LIMIT 1`)
    .get(nodeId) as { session_name: string; startup_status: string | null; resume_token: string | null; runtime: string; rig_id: string } | undefined;
  const inspect = async (nodeId: string) => {
    const current = session(nodeId);
    if (!current || !["claude-code", "codex"].includes(current.runtime)) return null;
    const protection = guard.preference(nodeId);
    const capture = await tmuxAdapter.capturePaneContent(current.session_name, 100).catch(() => "");
    const activity = deps.agentActivityStore?.getLatestForNode({ nodeId, sessionName: current.session_name });
    return { nodeId, sessionName: current.session_name,
      generation: sessionRegistry.currentOccupantTenure(nodeId)?.generationUuid ?? null,
      usage: contextUsageStore.getForNode(nodeId, current.session_name),
      idle: classifyPaneActivity(capture ?? "").state === "agent_idle" && activity?.state !== "running",
      protected: protection.desired || protection.effective,
      ready: current.startup_status === "ready" };
  };
  const verifyRecipient = async (nodeId: string): Promise<string | null> => {
    return confirmRenewalRecipient(deps, nodeId);
  };
  const handover = new SeatHandoverService({
    db, rigRepo, sessionRegistry, discoveryRepo: deps.discoveryRepo, eventBus: deps.eventBus, tmuxAdapter,
    sessionEnv: deps.sessionEnv, runtimeSessionEnv: deps.runtimeSessionEnv, runtimeAdapters: deps.runtimeAdapters,
    tmuxOptionDefaults: deps.tmuxOptionDefaults, contextUsageStore,
    resumeTokenCapturer: deps.resumeMetadataRefresher,
    claudeProcessStartedAt: name => observeClaudePaneStartedAt({ target: name, tmux: tmuxAdapter }),
    occupantInvalidator: deps.occupantInvalidator, activityOracle: deps.seatActivityService,
    authoredRecapResolver: ref => resolveAuthoredRecapPointer(ref, String(new SettingsStore().resolveOne("topology.root").value)),
    rebuildPrimingResolver: ref => buildRebuildPrimingChain(ref, {
      topologyRoot: String(new SettingsStore().resolveOne("topology.root").value), openrigHome: OPENRIG_HOME,
    }),
    predecessorRecapResolver: makePredecessorRecapResolver({
      readClaudeRecord: name => {
        const usage = contextUsageStore.readAndNormalize(name);
        return { transcriptPath: usage.transcriptPath, sessionId: usage.sessionId ?? null };
      },
      readCodexTranscriptPath: args => contextUsageStore.readCodexAndNormalize(args).transcriptPath,
      lookupResumeToken: (nodeId, name) => {
        const row = db.prepare("SELECT resume_token FROM sessions WHERE node_id=? AND session_name=? ORDER BY id DESC LIMIT 1")
          .get(nodeId, name) as { resume_token: string | null } | undefined;
        return row?.resume_token ?? null;
      },
    }),
  });
  const service = new SessionRenewalService({
    db,
    resolve: destination => {
      try { const target = guard.target(destination); return { nodeId: target.nodeId, sessionName: target.session }; }
      catch { return null; }
    },
    inspect, verifyRecipient,
    exclusive: (nodeId, fn) => guard.lifecycle([nodeId], fn),
    handover: async (seat, mode, beforeReplacement) => {
      const result = await handover.handover({ seatRef: seat.sessionName, source: mode,
        reason: "cold-used-context-before-delivery", beforeReplacement: async () =>
          await beforeReplacement() && await verifyRecipient(seat.nodeId) === seat.sessionName });
      return { ok: result.ok, ...(!result.ok ? { detail: result.message } : {}) };
    },
    escalate: async (qitemId, nodeId, episodeId) => {
      const current = db.prepare("SELECT session_name FROM sessions WHERE node_id=? ORDER BY id DESC LIMIT 1")
        .get(nodeId) as { session_name: string } | undefined;
      if (!current) return;
      await queueRepo.create({ qitemId: `renewal-${episodeId}`, sourceSession: current.session_name,
        destinationSession: "human@kernel", humanIntent: "decision",
        summary: `A renovação de sessão de ${current.session_name} falhou; o item ${qitemId} espera a cadeira ser recuperada.`,
        evidenceRef: `session-renewal:${episodeId}`,
        body: `OpenRig não confirmou uma sessão para ${current.session_name} após renovar. O item ${qitemId} continua pendente. Verifique a cadeira e retome a entrega após recuperar a sessão.`,
        tags: ["session-renewal", "destination-unverified"] });
    },
    audit: (nodeId, record) => {
      const node = db.prepare("SELECT rig_id FROM nodes WHERE id=?").get(nodeId) as { rig_id: string } | undefined;
      if (node) deps.eventBus.emit({ type: "seat.session_renewal", nodeId, rigId: node.rig_id, data: record });
    },
  });
  queueRepo.attachBeforeWake(async (id, destination) => {
    const accountGate = await provider?.beforeWake(id, destination);
    if (accountGate && !accountGate.ok) return accountGate;
    return service.beforeWake(id, destination);
  });
}
