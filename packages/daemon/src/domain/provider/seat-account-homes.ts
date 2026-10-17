import { existsSync, readFileSync, realpathSync } from "node:fs";
import path from "node:path";

export type AccountRuntime = "codex" | "claude-code";
export const SUBSCRIPTION_BILLING_ENV = ["OPENAI_API_KEY", "OPENAI_BASE_URL", "CODEX_API_KEY", "ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_BASE_URL",
  "CLAUDE_CODE_USE_BEDROCK", "CLAUDE_CODE_USE_VERTEX", "CLAUDE_CODE_USE_FOUNDRY"] as const;
export interface SeatAccountHome { account: string; runtime: AccountRuntime; home: string }

/** The saved seat map is authoritative even when a maintenance process starts
 * the daemon without the optional shell wrappers on PATH. No credential is read
 * or copied by launch environment resolution. An invalid mapped home fails shut.
 */
export class SeatAccountHomes {
  private readonly overrides = new Map<string, string>();
  constructor(readonly root: string) {}

  mappings(): Map<string, string> {
    const file = path.join(this.root, "seats.conf");
    if (!existsSync(file)) return new Map();
    const result = new Map<string, string>();
    for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const match = /^([^=\s]+)\s*=\s*([a-z][a-z0-9-]*)$/.exec(line);
      if (!match || result.has(match[1]!)) throw new Error("Invalid or duplicate seat account mapping.");
      result.set(match[1]!, match[2]!);
    }
    return result;
  }

  account(ref: string): SeatAccountHome {
    if (!/^(codex|claude)-[a-z0-9][a-z0-9-]*$/.test(ref)) throw new Error("Invalid account reference.");
    const runtime = ref.startsWith("codex-") ? "codex" : "claude-code";
    const root = realpathSync(this.root);
    const home = realpathSync(path.join(root, ref));
    if (path.dirname(home) !== root) throw new Error("Account home escapes the registry.");
    if (!existsSync(path.join(home, runtime === "codex" ? "auth.json" : ".credentials.json"))) {
      throw new Error("Mapped account has no native credentials; login is required.");
    }
    return { account: ref, runtime, home };
  }

  resolve(session: string, runtime?: string): SeatAccountHome | undefined {
    const ref = this.overrides.get(session) ?? this.mappings().get(session);
    if (!ref || (runtime !== undefined && !["codex", "claude-code"].includes(runtime))) return undefined;
    const account = this.account(ref);
    if (runtime && runtime !== account.runtime) throw new Error("Mapped account runtime differs from the seat runtime.");
    return account;
  }

  select(session: string, ref: string | undefined): void {
    if (ref === undefined) this.overrides.delete(session);
    else { this.account(ref); this.overrides.set(session, ref); }
  }

  environment(session: string, runtime?: string): Record<string, string> {
    const selected = this.resolve(session, runtime);
    if (!selected) return {};
    return { [selected.runtime === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]: selected.home,
      OPENRIG_ACCOUNT_REF: selected.account };
  }
}
