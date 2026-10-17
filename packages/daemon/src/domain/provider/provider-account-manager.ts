import { existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AppDeps } from "../../server.js";
import { shellQuote } from "../../adapters/shell-quote.js";
import { classifyPaneActivity } from "../session-transport.js";
import { OPENRIG_HOME } from "../../openrig-compat.js";
import { providerUsageDirectory, telemetrySidecarPath } from "../telemetry-state-paths.js";
import { collectClaudeSignalsFromProviderUsageDirectory } from "./claude-usage-reader.js";
import { SeatAccountHomes, SUBSCRIPTION_BILLING_ENV, type AccountRuntime, type SeatAccountHome } from "./seat-account-homes.js";
import { accountIdentity, codexRead, probeAccount, type AccountProbe } from "./native-account-probe.js";
import { nativeProcess, sameNativeProcess, nativeConversationConfirmed, stageConversation, resumeArguments, closeVacantShell, type NativeAccountProcess } from "./native-account-session.js";
import type { FourBlockReadModel, PrecheckResult } from "./provider-types.js";
import type { ProviderPrecheckInput, ProviderSwitchInput, ProviderSwitchResult } from "./provider-service.js";

interface Seat { nodeId: string; session: string; pane: string; rig: string; runtime: AccountRuntime;
  nativeSession: string; generation: string; startup: string; cwd: string }
interface Incident { node_id: string; account_ref: string; native_session: string; generation: string;
  detected_at: string; reset_at: string | null; notified: number; state: string }
const pause = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/** Subscription accounts are bound to seats, not to the daemon. Native processes
 * are the authority for current bindings; seats.conf remains the principal map.
 * All replacement shares the lifecycle lease used by compact and renewal.
 */
export class ProviderAccountManager {
  private polling = false;
  private switching: Promise<unknown> = Promise.resolve();
  private readonly quotaProbes = new Map<string, { at: number; result: AccountProbe }>();
  private timer?: ReturnType<typeof setInterval>;
  private readonly db;
  constructor(private readonly deps: AppDeps, readonly homes: SeatAccountHomes) {
    this.db = deps.rigRepo.db;
    // Existing intentional primary sharing is preserved; automatic reserves
    // must be free across every rig, including saved principal allocations.
    this.db.prepare("INSERT OR IGNORE INTO provider_rotation_policies(rig_name,enabled) VALUES ('agency-sites',1)").run();
    for (const row of this.db.prepare("SELECT n.id,n.runtime,s.session_name FROM nodes n JOIN sessions s ON s.node_id=n.id WHERE s.status='running'").all() as any[]) {
      const binding = this.db.prepare("SELECT account_ref FROM provider_account_bindings WHERE node_id=?").get(row.id) as any;
      if (binding) { try { this.homes.select(row.session_name, binding.account_ref); } catch { /* surfaced on launch/precheck */ } }
    }
    // A daemon crash never silently retries a replacement. Inspect its native
    // recipient before accepting the operation or releasing the reservation.
    for (const op of this.db.prepare("SELECT * FROM provider_account_operations WHERE state IN ('prepared','restarting')").all() as any[]) {
      this.db.prepare("UPDATE provider_account_operations SET state='recovery_required',reason='daemon_restarted_during_switch',updated_at=? WHERE id=?")
        .run(new Date().toISOString(), op.id);
    }
  }

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => {
      void this.tick().catch(() => console.warn("[provider rotation] Poll failed; pending work preserved."));
    }, 60_000);
    this.timer.unref();
  }
  stop(): void { if (this.timer) clearInterval(this.timer); this.timer = undefined; }

  private seats(): Seat[] {
    return this.db.prepare(`SELECT n.id AS nodeId,s.session_name AS session,b.tmux_pane AS pane,r.name AS rig,
      n.runtime,s.resume_token AS nativeSession,s.startup_status AS startup,n.cwd,
      (SELECT generation_uuid FROM occupant_tenures WHERE node_id=n.id ORDER BY generation_ordinal DESC LIMIT 1) AS generation
      FROM nodes n JOIN rigs r ON r.id=n.rig_id JOIN bindings b ON b.node_id=n.id
      JOIN sessions s ON s.node_id=n.id AND s.session_name=b.tmux_session
      WHERE s.status='running' AND n.runtime IN ('codex','claude-code')
      AND s.id=(SELECT MAX(x.id) FROM sessions x WHERE x.node_id=n.id AND x.status='running')`).all() as Seat[];
  }

  private seat(ref: string): Seat {
    const rows = this.seats().filter(s => s.session === ref || s.nodeId === ref);
    if (rows.length !== 1) throw new Error("Seat is absent or ambiguous.");
    const seat = rows[0]!;
    if (!seat.pane || !seat.generation || !seat.nativeSession || !/^[a-f0-9-]{36}$/i.test(seat.nativeSession)) throw new Error("Native conversation or occupant identity is unresolved.");
    return seat;
  }

  private async process(seat: Seat): Promise<NativeAccountProcess> {
    const pid = await this.deps.tmuxAdapter.getPanePid(seat.pane);
    const proc = pid ? nativeProcess(pid, seat.runtime) : null;
    if (!proc || proc.nodeId !== seat.nodeId || proc.session !== seat.session || proc.generation !== seat.generation || proc.cwd !== seat.cwd) {
      throw new Error("Current native process identity is unverified.");
    }
    return proc;
  }

  private accounts(): SeatAccountHome[] {
    if (!existsSync(this.homes.root)) return [];
    const result: SeatAccountHome[] = [];
    for (const entry of readdirSync(this.homes.root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !/^(codex|claude)-[a-z0-9-]+$/.test(entry.name)) continue;
      try { result.push(this.homes.account(entry.name)); } catch { /* unconnected homes remain unavailable */ }
    }
    return result;
  }

  private refForHome(home: string, runtime: AccountRuntime): string | null {
    const source = { account: "observed", runtime, home };
    const identity = accountIdentity(source);
    const accounts = this.accounts();
    return accounts.find(a => a.runtime === runtime && a.home === home)?.account
      ?? (identity ? accounts.find(a => a.runtime === runtime && accountIdentity(a) === identity)?.account : null) ?? null;
  }

  async getReadModel(): Promise<FourBlockReadModel> {
    const asOf = new Date().toISOString();
    const accounts = this.accounts().map(a => ({ accountId: a.account, label: a.account,
      provider: a.runtime === "codex" ? "codex" as const : "claude" as const,
      authState: "unknown" as const, profileRef: a.account, asOf }));
    const bindings: any[] = [];
    for (const seat of this.seats()) {
      let account: string | null = null, actualHome: string | null = null;
      try { const proc = await this.process(seat); actualHome = proc.home; account = this.refForHome(proc.home, seat.runtime); } catch { /* unknown is explicit */ }
      const saved = this.db.prepare("SELECT * FROM provider_account_bindings WHERE node_id=?").get(seat.nodeId) as any;
      const principal = this.homes.mappings().get(seat.session) ?? null;
      bindings.push({ accountId: account, seatSession: seat.session, rigName: seat.rig,
        boundAt: account ? saved?.changed_at ?? asOf : null, bindingSource: account ? "native_process_home_identity" : null,
        principalAccount: principal, actualHome, matchesPrincipal: account === principal && actualHome === this.accounts().find(a => a.account === principal)?.home,
        cacheEpoch: saved?.changed_at ?? null,
        anomalies: account ? [] : [{ kind: "seat_with_no_account", seat: seat.session, evidence: "native_process_unverified", asOf }] });
    }
    const signals = collectClaudeSignalsFromProviderUsageDirectory(providerUsageDirectory(OPENRIG_HOME))
      .map(signal => {
        const binding = bindings.find(b => b.seatSession === signal.seatSession);
        if (!binding?.accountId || (binding.cacheEpoch && Date.parse(signal.asOf) < Date.parse(binding.cacheEpoch))) {
          return { ...signal, usedPercent: undefined, remaining: undefined, automationUse: "do_not_automate" as const, unknownReason: "account_epoch_unverified" };
        }
        return { ...signal, accountRef: binding.accountId };
      });
    return { accounts, bindings, signals, asOf, hostUsage: [] };
  }

  private async eligible(seat: Seat, target: SeatAccountHome): Promise<{ source: NativeAccountProcess; probe: AccountProbe }> {
    if (target.runtime !== seat.runtime) throw new Error("Target account has a different provider.");
    if (seat.startup !== "ready") throw new Error("Seat startup is not ready.");
    const guard = this.deps.tmuxAdapter.deliveryGuard;
    if (!guard) throw new Error("Shared lifecycle guard is unavailable.");
    const protection = guard.preference(seat.nodeId);
    if (protection.desired || protection.effective) throw new Error("Seat is protected by typing guard.");
    const compaction = this.deps.compactionEnforcer as any;
    if (compaction?.hasPendingPostCompactStage?.(seat.session) || compaction?.hasPendingLifecycle?.(seat.session)) throw new Error("Compaction restore or preparation is pending.");
    const pendingRenewal = this.db.prepare("SELECT state FROM session_renewals WHERE node_id=? ORDER BY updated_at DESC LIMIT 1").get(seat.nodeId) as any;
    if (pendingRenewal && ["started", "renewing", "in_progress", "handover_started"].includes(pendingRenewal.state)) throw new Error("Session renewal is pending.");
    const source = await this.process(seat);
    const activity = this.deps.agentActivityStore?.getLatestForNode({ nodeId: seat.nodeId, sessionName: seat.session });
    const screen = await this.deps.tmuxAdapter.capturePaneScreen(seat.pane);
    if (activity?.state === "running" || classifyPaneActivity(screen ?? "", { timerlessStatusIsLive: true }).state !== "agent_idle") throw new Error("Seat is busy or idle state is unverified.");
    // An account with the same identity provides no additional subscription quota.
    const fromIdentity = accountIdentity({ account: "observed", runtime: seat.runtime, home: source.home });
    const targetIdentity = accountIdentity(target);
    const sameIdentity = fromIdentity !== null && targetIdentity === fromIdentity;
    const probe = await probeAccount(source.executable, target);
    if (!probe.authenticated) throw new Error("Target requires native subscription login.");
    // Moving the same exhausted identity into its isolated principal home is
    // configuration repair, not quota recovery. Its incident remains waiting.
    if (probe.exhausted && !sameIdentity) throw new Error("Target subscription quota is exhausted.");
    const exhausted = this.db.prepare("SELECT reset_at FROM provider_account_exhaustions WHERE account_ref=?").get(target.account) as any;
    if (!sameIdentity && exhausted && (!exhausted.reset_at || Date.parse(exhausted.reset_at) > Date.now())) throw new Error("Target has an unresolved quota incident.");
    return { source, probe };
  }

  async precheck(input: ProviderPrecheckInput): Promise<PrecheckResult & { detail?: string }> {
    try { await this.eligible(this.seat(input.seat), this.homes.account(input.toAccount)); return { safe: true }; }
    catch (error) { return { safe: false, reasons: ["would_strand_live_conversation"], detail: (error as Error).message }; }
  }

  async switchAccount(input: ProviderSwitchInput & { automatic?: boolean }): Promise<ProviderSwitchResult> {
    if (input.whenIdle) {
      try {
        const seat = this.seat(input.seat), target = this.homes.account(input.toAccount);
        if (target.runtime !== seat.runtime) throw new Error("Target account has a different provider.");
        await this.process(seat);
        this.db.prepare(`INSERT INTO provider_account_repairs(node_id,to_account,native_session,generation,state,created_at)
          VALUES (?,?,?,?,'waiting',?) ON CONFLICT(node_id) DO UPDATE SET to_account=excluded.to_account,
          native_session=excluded.native_session,generation=excluded.generation,state='waiting',created_at=excluded.created_at,reason=NULL`)
          .run(seat.nodeId, target.account, seat.nativeSession, seat.generation, new Date().toISOString());
        return { outcome: "rebind_in_progress" };
      } catch (error) { return { outcome: "failed_safely", reasons: [(error as Error).message] }; }
    }
    const result = this.switching.then(() => this.switchExclusive(input));
    this.switching = result.catch(() => {});
    return result;
  }

  private async switchExclusive(input: ProviderSwitchInput & { automatic?: boolean }): Promise<ProviderSwitchResult> {
    const guard = this.deps.tmuxAdapter.deliveryGuard;
    if (!guard) return { outcome: "failed_safely", reasons: ["shared_lifecycle_guard_unavailable"] };
    try {
      const initial = this.seat(input.seat);
      return await guard.lifecycle([initial.nodeId], async () => {
        const seat = this.seat(input.seat), target = this.homes.account(input.toAccount);
        if (input.automatic) {
          const identity = accountIdentity(target);
          if (!identity) throw new Error("Reserve identity is unverified.");
          const allocations = new Set(this.homes.mappings().values());
          for (const liveSeat of this.seats()) {
            const live = await this.process(liveSeat);
            const ref = this.refForHome(live.home, liveSeat.runtime);
            if (ref) allocations.add(ref);
            if (liveSeat.runtime === target.runtime && accountIdentity({ account: "observed", runtime: liveSeat.runtime, home: live.home }) === identity) {
              throw new Error("Reserve identity is already in use.");
            }
          }
          if (allocations.has(target.account) || this.db.prepare("SELECT 1 FROM provider_account_operations WHERE to_account=? AND state IN ('prepared','restarting','recovery_required')").get(target.account)) {
            throw new Error("Reserve account is allocated to another seat.");
          }
          for (const ref of allocations) {
            try { if (accountIdentity(this.homes.account(ref)) === identity) throw new Error("Reserve identity has a principal allocation."); }
            catch (error) { if ((error as Error).message === "Reserve identity has a principal allocation.") throw error; }
          }
        }
        const { source, probe } = await this.eligible(seat, target);
        if (input.automatic && seat.runtime === "codex" && !probe.quotaKnown) throw new Error("Reserve quota is unverified.");
        if (source.home === target.home) return { outcome: "succeeded" };
        const fromAccount = this.refForHome(source.home, seat.runtime);
        const args = resumeArguments(seat.runtime, source.args, seat.nativeSession);
        stageConversation(source.home, target, seat.nativeSession);
        if (seat.runtime === "codex") {
          const loaded = await codexRead(source.executable, target, "thread/read", { threadId: seat.nativeSession, includeTurns: false });
          if (loaded?.thread?.id !== seat.nativeSession) throw new Error("Target native loader did not confirm the conversation.");
        }
        const id = randomUUID(), at = new Date().toISOString();
        this.db.prepare(`INSERT INTO provider_account_operations(id,node_id,from_account,to_account,native_session,generation,state,created_at,updated_at)
          VALUES (?,?,?,?,?,?,'prepared',?,?)`).run(id, seat.nodeId, fromAccount, target.account, seat.nativeSession, seat.generation, at, at);
        let stopped = false, signalled = false;
        try {
          if (JSON.stringify(this.seat(input.seat)) !== JSON.stringify(seat) || !sameNativeProcess(source)) throw new Error("Seat identity changed during account validation.");
          // Native auth/thread checks can take seconds. Re-read the composer
          // immediately before cutover so a newly typed draft is preserved.
          const protection = guard.preference(seat.nodeId);
          const activity = this.deps.agentActivityStore?.getLatestForNode({ nodeId: seat.nodeId, sessionName: seat.session });
          const screen = await this.deps.tmuxAdapter.capturePaneScreen(seat.pane);
          if (protection.desired || protection.effective || activity?.state === "running"
            || classifyPaneActivity(screen ?? "", { timerlessStatusIsLive: true }).state !== "agent_idle") {
            throw new Error("Seat became busy or protected during account validation.");
          }
          const remain = await this.deps.tmuxAdapter.setRemainOnExit(seat.pane, true);
          if (!remain.ok) throw new Error("Cannot preserve the current pane.");
          this.db.prepare("UPDATE provider_account_operations SET state='restarting',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
          signalled = true;
          process.kill(source.pid, "SIGTERM");
          for (let i = 0; i < 50 && sameNativeProcess(source); i++) await pause(100);
          if (sameNativeProcess(source)) throw new Error("Native process did not exit safely; no forced kill was performed.");
          stopped = true;
          if (!await this.deps.tmuxAdapter.isPaneDead(seat.pane)) await this.deps.tmuxAdapter.signalPaneProcess(seat.nodeId, "TERM");
          if (!await this.deps.tmuxAdapter.isPaneDead(seat.pane)) {
            const shellPid = await this.deps.tmuxAdapter.getPanePid(seat.pane);
            if (shellPid) closeVacantShell(shellPid);
          }
          for (let i = 0; i < 30 && !await this.deps.tmuxAdapter.isPaneDead(seat.pane); i++) {
            // The managed wrapper may be reaped after the native child exits.
            // Retry only a positively vacant shell; never signal a live child.
            const shellPid = await this.deps.tmuxAdapter.getPanePid(seat.pane);
            if (shellPid) closeVacantShell(shellPid);
            await pause(100);
          }
          if (!await this.deps.tmuxAdapter.isPaneDead(seat.pane)) throw new Error("Pane did not reach the preserved dead state.");
          this.homes.select(seat.session, target.account);
          const env = { ...this.homes.environment(seat.session, seat.runtime), OPENRIG_ACCOUNT_EPOCH: at,
            OPENRIG_NODE_ID: seat.nodeId, OPENRIG_SESSION_NAME: seat.session, OPENRIG_RUNTIME: seat.runtime,
            OPENRIG_OCCUPANT_GENERATION: seat.generation };
          const command = `/usr/bin/env ${SUBSCRIPTION_BILLING_ENV.map(k => `-u ${k}`).join(" ")} ${Object.entries(env).map(([k,v]) => shellQuote(`${k}=${v}`)).join(" ")} ${shellQuote(source.executable)} ${args.map(shellQuote).join(" ")}`;
          // Guarded writes address the node, never the bare pane: tmux recycles pane ids, and a stopped
          // rig's binding to the same id makes a pane selector ambiguous (the guard refuses it, #141).
          const result = await this.deps.tmuxAdapter.respawnPane(seat.nodeId, command, { cwd: source.cwd, env });
          if (!result.ok) throw new Error("Native conversation restart failed.");
          let verified = false;
          for (let i = 0; i < 60; i++) {
            await pause(250);
            try {
              const live = await this.process(seat);
              const screen = i >= 5 ? await this.deps.tmuxAdapter.capturePaneScreen(seat.pane) : null;
              if (live.home === target.home && nativeConversationConfirmed(live, seat.runtime, seat.nativeSession)
                && screen && classifyPaneActivity(screen, { timerlessStatusIsLive: true }).state === "agent_idle") { verified = true; break; }
            } catch { /* native startup is bounded */ }
          }
          if (!verified) throw new Error("Native recipient was not confirmed after restart.");
          this.db.transaction(() => {
            this.db.prepare(`INSERT INTO provider_account_bindings(node_id,account_ref,native_session,generation,changed_at) VALUES (?,?,?,?,?)
              ON CONFLICT(node_id) DO UPDATE SET account_ref=excluded.account_ref,native_session=excluded.native_session,generation=excluded.generation,changed_at=excluded.changed_at`)
              .run(seat.nodeId, target.account, seat.nativeSession, seat.generation, at);
            this.db.prepare("UPDATE provider_account_operations SET state='succeeded',updated_at=? WHERE id=?").run(new Date().toISOString(), id);
          })();
          return { outcome: "succeeded" };
        } catch (error) {
          let rolledBack = false;
          if (stopped) {
            try {
              // Roll back only when the replacement can be positively fenced.
              // An unknown recipient is left for recovery, never force-killed.
              if (!await this.deps.tmuxAdapter.isPaneDead(seat.pane)) {
                const replacement = await this.process(seat);
                if (replacement.home !== target.home || !replacement.args.includes(seat.nativeSession) || !sameNativeProcess(replacement)) throw new Error("Rollback recipient is unknown.");
                process.kill(replacement.pid, "SIGTERM");
                for (let i = 0; i < 50 && sameNativeProcess(replacement); i++) await pause(100);
                if (sameNativeProcess(replacement)) throw new Error("Rollback recipient did not exit.");
                if (!await this.deps.tmuxAdapter.isPaneDead(seat.pane)) await this.deps.tmuxAdapter.signalPaneProcess(seat.nodeId, "TERM");
              }
              for (let i = 0; i < 30 && !await this.deps.tmuxAdapter.isPaneDead(seat.pane); i++) await pause(100);
              if (!await this.deps.tmuxAdapter.isPaneDead(seat.pane)) throw new Error("Rollback pane is unknown.");
              const env = { [seat.runtime === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: source.home,
                OPENRIG_ACCOUNT_REF: fromAccount ?? "", OPENRIG_NODE_ID: seat.nodeId,
                OPENRIG_SESSION_NAME: seat.session, OPENRIG_RUNTIME: seat.runtime, OPENRIG_OCCUPANT_GENERATION: seat.generation };
              const command = `/usr/bin/env ${Object.entries(env).map(([k,v]) => shellQuote(`${k}=${v}`)).join(" ")} ${shellQuote(source.executable)} ${args.map(shellQuote).join(" ")}`;
              const rollback = await this.deps.tmuxAdapter.respawnPane(seat.nodeId, command, { cwd: source.cwd, env });
              if (rollback.ok) for (let i = 0; i < 60; i++) {
                await pause(250);
                try { const live = await this.process(seat);
                  if (live.home === source.home && nativeConversationConfirmed(live, seat.runtime, seat.nativeSession)) { rolledBack = true; break; }
                } catch { /* bounded rollback observation */ }
              }
            } catch { /* recovery_required preserves an ambiguous recipient */ }
          }
          this.db.prepare("UPDATE provider_account_operations SET state=?,reason=?,updated_at=? WHERE id=?")
            .run(rolledBack || !signalled ? "failed_safely" : "recovery_required", (error as Error).message, new Date().toISOString(), id);
          if (rolledBack || !signalled) this.homes.select(seat.session, fromAccount ?? undefined);
          return { outcome: "failed_safely", reasons: [(error as Error).message] };
        }
      });
    } catch (error) { return { outcome: "failed_safely", reasons: [(error as Error).message] }; }
  }

  rotation(rig?: string): any {
    const policies = this.db.prepare("SELECT rig_name AS rig,enabled FROM provider_rotation_policies ORDER BY rig_name").all();
    const incidents = this.db.prepare("SELECT * FROM provider_quota_incidents WHERE state!='resumed'").all();
    const operations = this.db.prepare("SELECT * FROM provider_account_operations ORDER BY created_at DESC LIMIT 30").all();
    return { policies: rig ? policies.filter((p: any) => p.rig === rig) : policies, defaultEnabled: false, reserveMode: "exclusive-free", incidents, operations,
      exhaustedAccounts: this.db.prepare("SELECT * FROM provider_account_exhaustions").all(),
      pendingRepairs: this.db.prepare("SELECT * FROM provider_account_repairs WHERE state='waiting'").all() };
  }

  setRotation(rig: string, enabled: boolean): any {
    if (!this.db.prepare("SELECT 1 FROM rigs WHERE name=?").get(rig)) throw new Error("Unknown rig.");
    this.db.prepare("INSERT INTO provider_rotation_policies(rig_name,enabled) VALUES (?,?) ON CONFLICT(rig_name) DO UPDATE SET enabled=excluded.enabled").run(rig, enabled ? 1 : 0);
    return this.rotation(rig);
  }

  register(account: string): { account: string; home: string; loginCommand: string } {
    if (!/^(codex|claude)-[a-z0-9][a-z0-9-]*$/.test(account)) throw new Error("Invalid account reference.");
    const home = path.join(this.homes.root, account);
    if (existsSync(home)) throw new Error("Account home already exists; its credentials were preserved.");
    mkdirSync(home, { recursive: true, mode: 0o700 });
    const codex = account.startsWith("codex-");
    return { account, home, loginCommand: `${codex ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"}=${shellQuote(home)} ${codex ? "codex login" : "claude auth login"}` };
  }

  private incident(nodeId: string): Incident | undefined {
    return this.db.prepare("SELECT * FROM provider_quota_incidents WHERE node_id=? AND state!='resumed'").get(nodeId) as Incident | undefined;
  }

  private claudeQuota(seat: Seat, proc: NativeAccountProcess): { exhausted: boolean; resetAt: string | null } | null {
    try {
      const cache = JSON.parse(readFileSync(telemetrySidecarPath(providerUsageDirectory(OPENRIG_HOME), seat.session), "utf8"));
      const binding = this.db.prepare("SELECT changed_at FROM provider_account_bindings WHERE node_id=?").get(seat.nodeId) as any;
      const age = Date.now() - Date.parse(cache.asOf);
      if (cache.nodeId !== seat.nodeId || cache.generation !== seat.generation || cache.nativeSession !== seat.nativeSession
        || cache.accountHome !== proc.home || !Number.isFinite(age) || age < 0 || age > 30 * 60_000
        || (binding && Date.parse(cache.asOf) < Date.parse(binding.changed_at))) return null;
      const depleted = [cache.rateLimits?.five_hour, cache.rateLimits?.seven_day].filter(w => typeof w?.usedPercent === "number" && w.usedPercent >= 100);
      const resets = depleted.map(w => Date.parse(w.resetsAt)).filter(Number.isFinite);
      return { exhausted: depleted.length > 0, resetAt: resets.length ? new Date(Math.max(...resets)).toISOString() : null };
    } catch { return null; }
  }

  private async currentQuota(seat: Seat, proc: NativeAccountProcess): Promise<{ exhausted: boolean; resetAt: string | null; quotaKnown: boolean }> {
    if (seat.runtime === "claude-code") {
      const quota = this.claudeQuota(seat, proc);
      return { exhausted: quota?.exhausted ?? false, resetAt: quota?.resetAt ?? null, quotaKnown: quota !== null };
    }
    const key = seat.runtime + ":" + proc.home;
    const cached = this.quotaProbes.get(key);
    if (cached && Date.now() - cached.at < 55_000) return cached.result;
    const result = await probeAccount(proc.executable, { account: this.refForHome(proc.home, seat.runtime) ?? "observed", runtime: seat.runtime, home: proc.home });
    this.quotaProbes.set(key, { at: Date.now(), result });
    return result;
  }

  async beforeWake(_id: string, destination: string): Promise<{ ok: boolean; reason?: string }> {
    const seat = this.seats().find(s => s.session === destination || s.nodeId === destination);
    if (!seat) return { ok: true };
    if (this.db.prepare("SELECT 1 FROM provider_account_repairs WHERE node_id=? AND state='waiting'").get(seat.nodeId)) {
      return { ok: false, reason: "provider_account_switch_pending" };
    }
    if (this.db.prepare("SELECT 1 FROM provider_account_operations WHERE node_id=? AND state IN ('prepared','restarting','recovery_required')").get(seat.nodeId)) {
      return { ok: false, reason: "provider_account_recovery_pending" };
    }
    return this.incident(seat.nodeId) ? { ok: false, reason: "provider_quota_waiting" } : { ok: true };
  }

  /** Poll only typed, generation-verified native limit events. Permission prompts,
   * arbitrary transcript text and estimates cannot trigger account replacement.
   */
  async tick(): Promise<void> {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const repair of this.db.prepare("SELECT * FROM provider_account_repairs WHERE state='waiting'").all() as any[]) {
        try {
          const seat = this.seat(repair.node_id);
          if (seat.nativeSession !== repair.native_session || seat.generation !== repair.generation) {
            this.db.prepare("UPDATE provider_account_repairs SET state='stale',reason='recipient_changed' WHERE node_id=?").run(seat.nodeId);
            continue;
          }
          const result = await this.switchAccount({ seat: seat.session, toAccount: repair.to_account, forceUnsafe: false });
          this.db.prepare("UPDATE provider_account_repairs SET state=?,reason=? WHERE node_id=?").run(
            result.outcome === "succeeded" ? "completed" : "waiting",
            result.outcome === "failed_safely" ? result.reasons.join("; ") : null, seat.nodeId);
        } catch { /* Keep a missing or uncertain recipient visible without touching its draft. */ }
      }
      for (const operation of this.db.prepare("SELECT * FROM provider_account_operations WHERE state='recovery_required'").all() as any[]) {
        try {
          const seat = this.seat(operation.node_id), proc = await this.process(seat), target = this.homes.account(operation.to_account);
          if (seat.nativeSession !== operation.native_session || seat.generation !== operation.generation || proc.home !== target.home
            || !nativeConversationConfirmed(proc, seat.runtime, seat.nativeSession)) continue;
          const screen = await this.deps.tmuxAdapter.capturePaneScreen(seat.pane);
          if (!screen || classifyPaneActivity(screen, { timerlessStatusIsLive: true }).state !== "agent_idle") continue;
          this.db.transaction(() => {
            this.db.prepare(`INSERT INTO provider_account_bindings(node_id,account_ref,native_session,generation,changed_at) VALUES (?,?,?,?,?)
              ON CONFLICT(node_id) DO UPDATE SET account_ref=excluded.account_ref,native_session=excluded.native_session,generation=excluded.generation,changed_at=excluded.changed_at`)
              .run(seat.nodeId, target.account, seat.nativeSession, seat.generation, operation.created_at);
            this.db.prepare("UPDATE provider_account_operations SET state='succeeded',reason='verified_after_restart',updated_at=? WHERE id=?").run(new Date().toISOString(), operation.id);
          })();
          this.homes.select(seat.session, target.account);
        } catch { /* uncertain recipient stays visible; never repeat replacement */ }
      }
      for (const seat of this.seats()) {
        if (this.db.prepare("SELECT 1 FROM provider_account_repairs WHERE node_id=? AND state='waiting'").get(seat.nodeId)) continue;
        const policy = this.db.prepare("SELECT enabled FROM provider_rotation_policies WHERE rig_name=?").get(seat.rig) as any;
        if (!policy?.enabled) continue;
        const event = this.deps.agentActivityStore?.getLatestForNode({ nodeId: seat.nodeId, sessionName: seat.session });
        let incident = this.incident(seat.nodeId);
        if (incident && (incident.generation !== seat.generation || incident.native_session !== seat.nativeSession)) {
          this.db.prepare("UPDATE provider_quota_incidents SET state='resumed' WHERE node_id=?").run(seat.nodeId); incident = undefined;
        }
        if (!incident) {
          const kind = event?.rawSubtype ?? event?.rawEvent ?? event?.reason;
          const binding = this.db.prepare("SELECT changed_at FROM provider_account_bindings WHERE node_id=?").get(seat.nodeId) as any;
          const eventAt = event ? Date.parse(event.eventAt ?? event.sampledAt) : NaN;
          const typedLimit = !!event && event.runtime === seat.runtime && event.generationProvenance === "resolved"
            && ["at_limit", "rate_limit", "rate_limited"].includes(String(kind)) && event.generation === seat.generation
            && event.stale !== true && Number.isFinite(eventAt) && Date.now() - eventAt >= 0 && Date.now() - eventAt <= 60_000
            && (!binding || eventAt >= Date.parse(binding.changed_at));
          let proc: NativeAccountProcess;
          try { proc = await this.process(seat); } catch { continue; }
          const ref = this.refForHome(proc.home, seat.runtime);
          if (!ref) continue;
          let quota: { exhausted: boolean; resetAt: string | null; quotaKnown: boolean };
          try { quota = await this.currentQuota(seat, proc); } catch { continue; }
          if (!quota.exhausted && !typedLimit) continue;
          if (seat.runtime === "codex" && !quota.exhausted) continue;
          const reset = quota.resetAt;
          this.db.prepare("INSERT INTO provider_account_exhaustions(account_ref,reset_at,detected_at) VALUES (?,?,?) ON CONFLICT(account_ref) DO UPDATE SET reset_at=excluded.reset_at,detected_at=excluded.detected_at")
            .run(ref, reset, new Date().toISOString());
          this.db.prepare(`INSERT INTO provider_quota_incidents(node_id,account_ref,native_session,generation,detected_at,reset_at,state)
            VALUES (?,?,?,?,?,?,'waiting') ON CONFLICT(node_id) DO UPDATE SET account_ref=excluded.account_ref,native_session=excluded.native_session,
            generation=excluded.generation,detected_at=excluded.detected_at,reset_at=excluded.reset_at,notified=0,state='waiting'`)
            .run(seat.nodeId, ref, seat.nativeSession, seat.generation, new Date().toISOString(), reset);
          incident = this.incident(seat.nodeId);
        }
        if (!incident) continue;
        if (incident.state !== "waiting") continue;
        await this.recoverQuota(seat, incident);
      }
    } finally { this.polling = false; }
  }

  private async recoverQuota(seat: Seat, incident: Incident): Promise<void> {
    let proc: NativeAccountProcess;
    try { proc = await this.process(seat); } catch { return; }
    const currentRef = this.refForHome(proc.home, seat.runtime);
    if (currentRef && currentRef !== incident.account_ref
      && this.db.prepare("SELECT 1 FROM provider_account_operations WHERE node_id=? AND to_account=? AND native_session=? AND generation=? AND state='succeeded'")
        .get(seat.nodeId, currentRef, incident.native_session, incident.generation)) {
      await this.resumeIncident(seat, incident); return;
    }
    const occupied = new Set(this.homes.mappings().values());
    for (const other of this.seats()) {
      try { const live = await this.process(other); const ref = this.refForHome(live.home, other.runtime); if (ref) occupied.add(ref); } catch { return; }
    }
    for (const op of this.db.prepare("SELECT to_account FROM provider_account_operations WHERE state IN ('prepared','restarting','recovery_required')").all() as any[]) occupied.add(op.to_account);
    const exhaustedIdentity = accountIdentity({ account: incident.account_ref, runtime: seat.runtime, home: proc.home });
    const candidates = this.accounts().filter(a => a.runtime === seat.runtime && !occupied.has(a.account)
      && a.account !== incident.account_ref && accountIdentity(a) !== exhaustedIdentity);
    for (const candidate of candidates) {
      const result = await this.switchAccount({ seat: seat.session, toAccount: candidate.account, forceUnsafe: false, automatic: true });
      if (result.outcome === "succeeded") { await this.resumeIncident(seat, incident); return; }
    }
    // Unknown reset stays waiting and is re-probed at a bounded cadence. No
    // reset time is invented from an untyped UI sentence or an API cache TTL.
    if (!incident.reset_at || Date.parse(incident.reset_at) <= Date.now()) {
      try {
        const result = await probeAccount(proc.executable, { account: incident.account_ref, runtime: seat.runtime, home: proc.home });
        if (result.authenticated && ((seat.runtime === "codex" && result.quotaKnown && !result.exhausted)
          || (seat.runtime === "claude-code" && incident.reset_at && Date.parse(incident.reset_at) <= Date.now()))) {
          this.db.prepare("DELETE FROM provider_account_exhaustions WHERE account_ref=?").run(incident.account_ref);
          await this.resumeIncident(seat, incident); return;
        }
        if (result.resetAt) this.db.prepare("UPDATE provider_quota_incidents SET reset_at=? WHERE node_id=?").run(result.resetAt, seat.nodeId);
      } catch { /* keep pending work untouched */ }
    }
    if (!incident.notified && this.deps.queueRepo) {
      await this.deps.queueRepo.create({ qitemId: `quota-${seat.nodeId}-${incident.generation}-${Date.parse(incident.detected_at)}`,
        sourceSession: seat.session, destinationSession: "human@kernel", humanIntent: "update",
        summary: `Cota esgotada em ${seat.session}; aguardando conta livre ou reset.`,
        evidenceRef: `provider_quota_incidents:${seat.nodeId}:${incident.generation}`,
        body: `Cota esgotada em ${seat.session} (${incident.account_ref}). Nenhuma conta reserva livre confirmada. Conversa ${incident.native_session} e trabalho pendente preservados. Aguardando ${incident.reset_at ?? "reset informado pelo provedor"}.`, tags: ["provider-quota", "waiting-reset"] });
      this.db.prepare("UPDATE provider_quota_incidents SET notified=1 WHERE node_id=?").run(seat.nodeId);
    }
  }

  private async resumeIncident(seat: Seat, incident: Incident): Promise<void> {
    if (!this.deps.sessionTransport) return;
    const guard = this.deps.tmuxAdapter.deliveryGuard;
    if (!guard) return;
    await guard.lifecycle([seat.nodeId], async () => {
      const current = this.seat(seat.session);
      if (current.generation !== incident.generation || current.nativeSession !== incident.native_session) return;
      // Claim before input: a crash leaves a visible uncertain delivery and does
      // not repeat the wake. Existing owned work remains the source of truth.
      const claimed = this.db.prepare("UPDATE provider_quota_incidents SET state='resuming' WHERE node_id=? AND state='waiting'").run(seat.nodeId).changes;
      if (!claimed) return;
      const result = await this.deps.sessionTransport!.send(seat.session,
        "A cota da conta está disponível novamente. Retome a tarefa interrompida nesta mesma conversa, verificando primeiro o estado atual e os itens já concluídos. Não crie uma nova tarefa nem repita ações concluídas.", { waitForIdleMs: 1000 });
      this.db.prepare("UPDATE provider_quota_incidents SET state=? WHERE node_id=?").run(result.ok && result.outcome !== "retained" ? "resumed" : "waiting", seat.nodeId);
    });
  }
}
