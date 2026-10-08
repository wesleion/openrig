import { readFileSync } from "node:fs";
import { join } from "node:path";

/** Mirrors the local account wrapper without executing it or reading credentials. */
export function resolveSeatCodexHome(session: string | null | undefined, home: string): string | undefined {
  if (!session) return undefined;
  let text: string;
  try { text = readFileSync(join(home, ".agent-homes", "seats.conf"), "utf8"); }
  catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw e; }
  const match = text.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"))
    .map(s => s.split("=")).find(([name]) => name === session);
  if (!match) return undefined;
  const account = match[1]?.trim();
  if (!account || !/^codex-[a-zA-Z0-9_-]+$/.test(account)) throw new Error(`Invalid Codex account mapping for ${session}`);
  return join(home, ".agent-homes", account);
}
