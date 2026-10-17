import { loadHumanRegistry } from "./human-registry.js";
import { loadHumanBridges } from "./human-bridge-config.js";
import { HumanBridgeMailbox } from "./human-bridge-mailbox.js";
import type { QueueRepository } from "../queue-repository.js";
import type { OutboundDecision } from "./protocol.js";
import type { SubsystemDeliveryOutcome } from "./gateway-subsystem.js";

/** The primary binding selects the transport. Hermes decisions never reach Slack. */
export function buildHumanBridgeDelivery(home: string, queue: QueueRepository) {
  const mailbox = new HumanBridgeMailbox(queue.db, { home, queue });
  mailbox.recoverNativeDeliveries();
  return {
    enabled: () => loadHumanBridges(home).length > 0,
    deliver: async (decision: OutboundDecision): Promise<SubsystemDeliveryOutcome | undefined> => {
      const registry = loadHumanRegistry(home, { readOnly: true });
      if (!registry.ok) return { ok: false, class: "human-registry-unavailable", detail: registry.error };
      const human = registry.entities.find(h => h.address === decision.entityBindingRef);
      const primary = human?.connectorBindings.find(b => b.role === "primary");
      if (primary?.kind !== "hermes") return undefined;
      const bridge = loadHumanBridges(home).find(b => b.id === primary.connectorRef && b.humanAddress === human!.address);
      if (!bridge) return { ok: false, class: "human-bridge-not-configured" };
      const delivered = mailbox.acceptGatewayDecision(bridge, decision);
      if (delivered) mailbox.recoverNativeDeliveries();
      return delivered ? { ok: true } : { ok: false, class: "http-pull-pending" };
    },
  };
}
