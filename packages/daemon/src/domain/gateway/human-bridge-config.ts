import { createHash, timingSafeEqual } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadHumanRegistry, type HumanFragment } from "./human-registry.js";

export interface HumanBridgeConfig {
  id: string;
  enabled: boolean;
  humanAddress: string;
  legacyAliases: string[];
  tokenSha256: string;
  scopes: Array<"inbox" | "receipts" | "answer" | "create">;
  allowedDestinations: string[];
  origins: Record<string, { projectId: string; projectName: string }>;
}

export function validateHumanBridgeConfig(b: HumanBridgeConfig, entities: readonly HumanFragment[]): HumanBridgeConfig {
  if (!b || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(b.id ?? "") || typeof b.enabled !== "boolean" ||
      !/^[a-f0-9]{64}$/.test(b.tokenSha256 ?? "") || !Array.isArray(b.legacyAliases) ||
      b.legacyAliases.some(a => a !== "human@kernel") || !Array.isArray(b.scopes) ||
      b.scopes.some(s => !["inbox", "receipts", "answer", "create"].includes(s)) ||
      !Array.isArray(b.allowedDestinations) || b.allowedDestinations.some(s => typeof s !== "string" || !s) ||
      !b.origins || typeof b.origins !== "object" || Array.isArray(b.origins) || Object.values(b.origins).some(v => !v || typeof v.projectId !== "string" || !v.projectId.trim() || typeof v.projectName !== "string" || !v.projectName.trim())) throw new Error("Invalid human bridge configuration");
  const human = entities.find(e => e.address === b.humanAddress);
  if (!human?.connectorBindings.some(x => x.kind === "hermes" && x.connectorRef === b.id && x.handle)) throw new Error(`Bridge ${b.id} requires a registered Hermes binding with a platform handle`);
  return b;
}

export function loadHumanBridges(home: string, opts?: { includeDisabled?: boolean }): HumanBridgeConfig[] {
  let names: string[];
  try { names = readdirSync(join(home, "gateway", "bridges")); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
  const registry = loadHumanRegistry(home, { readOnly: true });
  if (!registry.ok) return [];
  const bridges = names.filter(n => n.endsWith(".json")).map(n => {
    const b = JSON.parse(readFileSync(join(home, "gateway", "bridges", n), "utf8")) as HumanBridgeConfig;
    return validateHumanBridgeConfig(b, registry.entities);
  }).filter(b => b.enabled || opts?.includeDisabled);
  const enabled = bridges.filter(b => b.enabled);
  if (new Set(enabled.map(b => b.id)).size !== enabled.length || new Set(enabled.map(b => b.tokenSha256)).size !== enabled.length) throw new Error("Bridge IDs and credentials must be unique");
  return bridges;
}

export function bridgeForToken(home: string, token: string): HumanBridgeConfig | undefined {
  const digest = createHash("sha256").update(token).digest();
  return loadHumanBridges(home).find(b => timingSafeEqual(digest, Buffer.from(b.tokenSha256, "hex")));
}

export function askedHumanMatches(destination: string, actor: string, aliases: readonly string[] = []): boolean {
  return destination === actor || aliases.includes(destination);
}
