import type Database from "better-sqlite3";
import type { HumanFragment } from "./human-registry.js";
import type { HumanDeliveryReadiness } from "./human-readiness.js";
import { loadHumanBridges } from "./human-bridge-config.js";

/** Readiness of the pull connector is separate from Slack socket connectivity. */
export function resolveHermesReadiness(home: string, db: Database.Database | undefined, human: HumanFragment, now = new Date()): HumanDeliveryReadiness {
  const primary = human.connectorBindings.find(b => b.role === "primary")!;
  const bridge = loadHumanBridges(home, { includeDisabled: true }).find(b => b.id === primary.connectorRef && b.humanAddress === human.address);
  const presence = db?.prepare("SELECT last_poll_at FROM human_bridge_presence WHERE bridge_id = ? AND human_address = ?").get(primary.connectorRef, human.address) as { last_poll_at: string } | undefined;
  const elapsed = presence ? now.getTime() - Date.parse(presence.last_poll_at) : Number.POSITIVE_INFINITY;
  const active = !!bridge?.enabled && elapsed >= 0 && elapsed < 90_000;
  const delivered = !!db?.prepare("SELECT 1 FROM human_bridge_dispatch WHERE bridge_id = ? AND human_address = ? AND status = 'delivered' LIMIT 1").get(primary.connectorRef, human.address);
  const ready = active && delivered;
  return { state: ready ? "ready" : active ? "indeterminate" : "not-ready", configured: !!bridge,
    enabled: !!bridge?.enabled, active, ready, connector: { kind: "hermes", ref: primary.connectorRef }, checkedAt: now.toISOString(),
    reason: ready ? "Bridge polling is active and Hermes has reported a delivered message" : active ? "Bridge polling is active; successful Telegram delivery has not been reported" : "Bridge is missing, disabled, or has not polled within 90 seconds",
    nextAction: ready ? null : "Poll the authenticated bridge inbox and report a verified Telegram delivery receipt" };
}
