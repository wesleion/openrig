import type { MiddlewareHandler } from "hono";
import { constantTimeEqual } from "./auth-bearer-token.js";
import { bridgeForToken, type HumanBridgeConfig } from "../domain/gateway/human-bridge-config.js";

export function isLoopbackPeer(address: string | undefined): boolean {
  if (!address) return false;
  return address === "::1" || /^(?:::ffff:)?127(?:\.\d{1,3}){3}$/.test(address);
}

export function networkWriteAuth(opts: {
  home: string;
  operatorTokens: Array<string | null | undefined>;
  terminalToken?: string | null;
  activityHookToken?: string;
  peerAddress?: (c: Parameters<MiddlewareHandler>[0]) => string | undefined;
}): MiddlewareHandler {
  return async (c, next) => {
    const path = c.req.path;
    const terminalPath = /^\/api\/(terminal|transport|compaction)(\/|$)/.test(path);
    const queryToken = terminalPath && c.req.method === "GET" ? c.req.query("token")?.trim() : undefined;
    const token = /^Bearer\s+(.+)$/i.exec(c.req.header("Authorization") ?? "")?.[1]?.trim() ?? queryToken;
    const operator = !!token && opts.operatorTokens.some(t => !!t && constantTimeEqual(token, t));
    const terminal = !!token && terminalPath && !!opts.terminalToken && constantTimeEqual(token, opts.terminalToken);
    const activity = !!token && path === "/api/activity/hooks" && c.req.method === "POST" && !!opts.activityHookToken && constantTimeEqual(token, opts.activityHookToken);
    let bridge: HumanBridgeConfig | undefined;
    if (token && !operator && !terminal && !activity) {
      try { bridge = bridgeForToken(opts.home, token); }
      catch { return c.json({ error: "bridge_configuration_invalid" }, 503); }
    }
    const bridgeOnly = path.startsWith("/api/bridge/");
    const mutation = !["GET", "HEAD", "OPTIONS"].includes(c.req.method) ||
      (c.req.header("Upgrade") ?? "").toLowerCase() === "websocket";
    if (bridge) {
      let scope: HumanBridgeConfig["scopes"][number] | undefined;
      if (path === "/api/bridge/inbox" && c.req.method === "GET") scope = "inbox";
      if (path === "/api/bridge/receipts" && c.req.method === "POST") scope = "receipts";
      if (/^\/api\/queue\/[^/]+\/answer$/.test(path) && c.req.method === "POST") scope = "answer";
      if (path === "/api/queue/create" && c.req.method === "POST") scope = "create";
      if (!scope || !bridge.scopes.includes(scope)) return c.json({ error: "bridge_scope_forbidden" }, 403);
      c.set("humanBridge" as never, bridge);
      await next();
      return;
    }
    if (bridgeOnly) return c.json({ error: "bridge_credential_required" }, 401);
    const peer = opts.peerAddress?.(c) ?? c.env?.incoming?.socket?.remoteAddress;
    if (mutation && !operator && !terminal && !activity && !isLoopbackPeer(peer)) {
      return c.json({ error: "credential_required", message: "Remote writes require an operator or scoped bridge credential" }, 401);
    }
    if (token && !operator && !terminal && !activity && !isLoopbackPeer(peer)) return c.json({ error: "invalid_credential" }, 401);
    await next();
  };
}
