import { Command } from "commander";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DaemonClient } from "../client.js";
import { getOpenRigHome } from "../openrig-compat.js";

async function request(method: "GET" | "POST", path: string, body?: unknown) {
  const client = new DaemonClient();
  const bearer = process.env.OPENRIG_AUTH_BEARER_TOKEN;
  const opts = bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : undefined;
  const res = method === "GET" ? await client.get<unknown>(path, opts) : await client.post<unknown>(path, body, opts);
  console.log(JSON.stringify(res.data));
  if (res.status >= 400) process.exitCode = 1;
}
export function bridgeCommand(): Command {
  const cmd = new Command("bridge").description("Scoped HTTP human bridge; registration is explicit");
  cmd.command("create").requiredOption("--request-file <path>", "JSON queue request with requestId and qitemId")
    .option("--json").action(async opts => { await request("POST", "/api/queue/create", JSON.parse(readFileSync(opts.requestFile, "utf8"))); });
  cmd.command("inbox").option("--cursor <cursor>").option("--json").action(async opts => {
    await request("GET", `/api/bridge/inbox${opts.cursor !== undefined ? `?cursor=${encodeURIComponent(opts.cursor)}` : ""}`);
  });
  cmd.command("receipt").requiredOption("--receipt-file <path>", "JSON receipt; reserve an attempting status before sending").option("--json").action(async opts => {
    await request("POST", "/api/bridge/receipts", JSON.parse(readFileSync(opts.receiptFile, "utf8")));
  });
  cmd.command("reconcile <bridgeId> <decisionId>").requiredOption("--request-id <id>").requiredOption("--action <action>", "confirm or retry (retry may create a duplicate Telegram message)")
    .option("--chat-id <id>").option("--message-id <id>").option("--actor <session>").option("--json").action(async (bridgeId, decisionId, opts) => {
      await request("POST", `/api/bridge-admin/${encodeURIComponent(bridgeId)}/reconcile`, { decisionId, requestId: opts.requestId, action: opts.action,
        chatId: opts.chatId, messageId: opts.messageId, actorSession: opts.actor ?? process.env.OPENRIG_SESSION_NAME ?? "operator@local" });
    });
  cmd.command("configure").requiredOption("--config-file <path>", "Bridge configuration JSON, including explicit enabled flag")
    .requiredOption("--token-file <path>", "Private bridge token file; only its SHA-256 is stored")
    .action(async opts => {
      const home = getOpenRigHome();
      const token = readFileSync(opts.tokenFile, "utf8").trim();
      if (token.length < 32) throw new Error("Bridge credential must contain at least 32 characters");
      const config = { ...JSON.parse(readFileSync(opts.configFile, "utf8")), tokenSha256: createHash("sha256").update(token).digest("hex") };
      const registry = await import("@openrig/daemon/gateway-human-registry");
      const loaded = registry.loadHumanRegistry(home, { readOnly: true });
      if (!loaded.ok) throw new Error(loaded.error);
      const { validateHumanBridgeConfig, loadHumanBridges } = await import("@openrig/daemon/gateway-human-bridge");
      validateHumanBridgeConfig(config, loaded.entities);
      if (config.enabled && loadHumanBridges(home).some(b => b.id !== config.id && b.tokenSha256 === config.tokenSha256)) throw new Error("Credential is already assigned to another enabled bridge");
      const dir = join(home, "gateway", "bridges");
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = join(dir, `${config.id}.json`), tmp = `${target}.${process.pid}.tmp`;
      writeFileSync(tmp, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
      renameSync(tmp, target);
      console.log(JSON.stringify({ bridgeId: config.id, humanAddress: config.humanAddress, enabled: config.enabled }));
    });
  return cmd;
}
