import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { SUBSCRIPTION_BILLING_ENV, type SeatAccountHome } from "./seat-account-homes.js";

export interface AccountProbe { authenticated: boolean; identity: string | null; exhausted: boolean; resetAt: string | null; quotaKnown: boolean }

export function accountIdentity(account: SeatAccountHome): string | null {
  try {
    let identity: string | undefined;
    if (account.runtime === "codex") {
      const auth = JSON.parse(readFileSync(path.join(account.home, "auth.json"), "utf8"));
      const jwt = auth.tokens?.id_token ?? auth.tokens?.access_token;
      const claims = jwt ? JSON.parse(Buffer.from(jwt.split(".")[1], "base64url").toString("utf8")) : {};
      identity = auth.tokens?.account_id ?? claims["https://api.openai.com/auth"]?.chatgpt_account_id;
    } else {
      const files = [path.join(account.home, ".claude.json"), path.join(account.home, "settings.json")];
      if (path.basename(account.home) === ".claude") files.push(path.join(path.dirname(account.home), ".claude.json"));
      for (const file of files) {
        if (!existsSync(file)) continue;
        const state = JSON.parse(readFileSync(file, "utf8"));
        identity = state.oauthAccount?.accountUuid;
        if (identity) break;
      }
    }
    return identity ? createHash("sha256").update(account.runtime + ":" + identity).digest("hex") : null;
  } catch { return null; }
}

export function subscriptionEnvironment(account: SeatAccountHome): NodeJS.ProcessEnv {
  const env = { ...process.env, [account.runtime === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: account.home };
  for (const key of SUBSCRIPTION_BILLING_ENV) delete env[key];
  return env;
}

/** Native stdio protocol. No turn/start, model inference, API fallback or login.
 * Response bodies never leave this helper except the requested structured result.
 */
export async function codexRead(executable: string, account: SeatAccountHome,
  method: string, params: Record<string, unknown>): Promise<any> {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, ["app-server"], { env: subscriptionEnvironment(account), stdio: ["pipe", "pipe", "pipe"] });
    let buffer = "", bytes = 0, finished = false;
    const finish = (error?: Error, value?: unknown) => {
      if (finished) return;
      finished = true; clearTimeout(timer); child.kill("SIGTERM");
      error ? reject(error) : resolve(value);
    };
    const timer = setTimeout(() => finish(new Error("Native account query timed out.")), 15_000);
    const send = (id: number, name: string, body: unknown) => child.stdin.write(JSON.stringify({ id, method: name, params: body }) + "\n");
    child.on("error", () => finish(new Error("Native account query could not start.")));
    child.on("exit", () => finish(new Error("Native account query exited before responding.")));
    child.stderr.on("data", () => {});
    child.stdout.on("data", chunk => {
      bytes += chunk.length;
      if (bytes > 4 * 1024 * 1024) return finish(new Error("Native account response exceeded its bound."));
      buffer += chunk.toString();
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, newline); buffer = buffer.slice(newline + 1);
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) return finish(new Error("Native account initialization refused."));
          child.stdin.write(JSON.stringify({ method: "initialized", params: {} }) + "\n");
          send(2, method, params);
        } else if (message.id === 2) {
          if (message.error) return finish(new Error("Native account or conversation query refused."));
          finish(undefined, message.result);
        }
      }
    });
    send(1, "initialize", { clientInfo: { name: "openrig-account-probe", version: "1.0.0" } });
  });
}

export function quotaFromRateLimits(result: any, now = Date.now()): Pick<AccountProbe, "exhausted" | "resetAt" | "quotaKnown"> {
  const limits = result?.rateLimitsByLimitId ? Object.values(result.rateLimitsByLimitId) : [result?.rateLimits];
  const depleted: number[] = [];
  let exhausted = false;
  let quotaKnown = false;
  for (const limit of limits as any[]) for (const window of [limit?.primary, limit?.secondary]) {
    if (typeof window?.usedPercent !== "number" || !Number.isFinite(window.usedPercent) || window.usedPercent < 0) continue;
    quotaKnown = true;
    if (window.usedPercent < 100) continue;
    const reset = typeof window.resetsAt === "number" ? window.resetsAt * 1000 : NaN;
    if (Number.isFinite(reset) && reset <= now) continue;
    exhausted = true;
    if (Number.isFinite(reset)) depleted.push(reset);
  }
  return { exhausted, resetAt: depleted.length ? new Date(Math.max(...depleted)).toISOString() : null, quotaKnown };
}

export async function probeAccount(executable: string, account: SeatAccountHome): Promise<AccountProbe> {
  if (account.runtime === "codex") {
    const auth = await codexRead(executable, account, "account/read", { refreshToken: false });
    const authenticated = auth?.account?.type === "chatgpt";
    if (!authenticated) return { authenticated: false, identity: null, exhausted: false, resetAt: null, quotaKnown: false };
    const id = auth.account.id;
    const identity = typeof id === "string" ? createHash("sha256").update("codex:" + id).digest("hex") : accountIdentity(account);
    const limits = await codexRead(executable, account, "account/rateLimits/read", {});
    return { authenticated, identity, ...quotaFromRateLimits(limits) };
  }
  const auth = await new Promise<any>((resolve, reject) => {
    execFile(executable, ["auth", "status", "--json"], { env: subscriptionEnvironment(account), timeout: 10_000, maxBuffer: 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(new Error("Native Claude authentication query failed."));
        try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Native Claude authentication response was invalid.")); }
      });
  });
  return { authenticated: auth.loggedIn === true && ["oauth", "claude.ai"].includes(auth.authMethod)
    && (auth.apiProvider === undefined || auth.apiProvider === "firstParty"),
    identity: accountIdentity(account), exhausted: false, resetAt: null, quotaKnown: false };
}
