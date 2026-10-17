import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, readlinkSync, realpathSync, statSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import type { AccountRuntime, SeatAccountHome } from "./seat-account-homes.js";

export interface NativeAccountProcess {
  pid: number; start: string; image: string; executable: string; args: string[]; home: string;
  nodeId: string; generation: string; session: string; cwd: string;
}

export function nativeProcess(panePid: number, runtime: AccountRuntime): NativeAccountProcess | null {
  const rows = new Map<number, { parent: number; start: string }>();
  for (const name of readdirSync("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = readFileSync(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
      rows.set(Number(name), { parent: Number(fields[1]), start: fields[19]! });
    } catch { /* processes can exit during observation */ }
  }
  const belongs = (pid: number) => {
    const seen = new Set<number>();
    while (pid > 1 && !seen.has(pid)) {
      if (pid === panePid) return true;
      seen.add(pid); pid = rows.get(pid)?.parent ?? 0;
    }
    return false;
  };
  const found: NativeAccountProcess[] = [];
  for (const [pid, row] of rows) {
    if (!belongs(pid)) continue;
    try {
      const image = readlinkSync(`/proc/${pid}/exe`);
      const name = path.basename(image.replace(/ \(deleted\)$/, ""));
      if (runtime === "codex" ? name !== "codex" : !["claude", "claude.exe"].includes(name)) continue;
      const command = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").filter(Boolean);
      // npm can replace a live native image. Observe that exact image for PID
      // fencing, but use the still-installed native path for help and restart.
      const executable = image.endsWith(" (deleted)") ? realpathSync(command[0]!) : image;
      const args = command.slice(1);
      if (args.includes("app-server") || args.includes("auth")) continue;
      const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, "utf8").split("\0").filter(Boolean)
        .map(pair => { const at = pair.indexOf("="); return [pair.slice(0, at), pair.slice(at + 1)]; }));
      const home = env[runtime === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR"]
        ?? path.join(env.HOME ?? "", runtime === "codex" ? ".codex" : ".claude");
      if (!path.isAbsolute(home)) continue;
      found.push({ pid, start: row.start, image, executable, args, home,
        nodeId: env.OPENRIG_NODE_ID ?? "", generation: env.OPENRIG_OCCUPANT_GENERATION ?? "",
        session: env.OPENRIG_SESSION_NAME ?? "", cwd: readlinkSync(`/proc/${pid}/cwd`) });
    } catch { /* no positive identity, no selection */ }
  }
  return found.length === 1 ? found[0]! : null;
}

export function sameNativeProcess(before: NativeAccountProcess): boolean {
  try {
    const stat = readFileSync(`/proc/${before.pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === before.start
      && readlinkSync(`/proc/${before.pid}/exe`) === before.image;
  } catch { return false; }
}

/** Interactive shells ignore TERM. HUP is allowed only for a positively
 * identified shell with no remaining child process, never a live agent/job. */
export function closeVacantShell(pid: number): boolean {
  try {
    const image = readlinkSync(`/proc/${pid}/exe`);
    if (!["bash", "sh", "dash", "zsh"].includes(path.basename(image))) return false;
    const started = () => {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
    };
    const stamp = started();
    if (readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim()) return false;
    // CPU counters and signal bookkeeping can change after TERM without a PID
    // replacement. Fence the immutable process start and executable instead.
    if (!stamp || started() !== stamp || readlinkSync(`/proc/${pid}/exe`) !== image
      || readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim()) return false;
    process.kill(pid, "SIGHUP");
    return true;
  } catch { return false; }
}

export function nativeConversationConfirmed(proc: NativeAccountProcess, runtime: AccountRuntime, sessionId: string): boolean {
  if (!sameNativeProcess(proc) || !proc.args.includes(sessionId)) return false;
  if (runtime === "codex") return true; // exact thread was admitted by the native loader before cutover
  try {
    const state = JSON.parse(readFileSync(path.join(proc.home, "sessions", `${proc.pid}.json`), "utf8"));
    return state.sessionId === sessionId && state.pid === proc.pid && state.cwd === proc.cwd
      && String(state.procStart) === proc.start;
  } catch { return false; }
}

export function resumeArguments(runtime: AccountRuntime, args: readonly string[], sessionId: string): string[] {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error("Native resume ID is invalid.");
  if (args.some(arg => /^(--api-key|--print|--prompt|-p|exec|app-server)$/.test(arg))) throw new Error("Unsupported native interactive launch arguments.");
  const next: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    // `codex resume --add-dir DIR <id>`: the selector can follow resume's own options. Left behind, the
    // id becomes a top-level PROMPT and the resumed agent spends a turn answering it.
    if (arg.toLowerCase() === sessionId.toLowerCase()) continue;
    if (["--session-id", "--resume", "-r"].includes(arg)) { i++; continue; }
    if (/^--(session-id|resume)=/.test(arg) || ["--continue", "-c", "--fork-session"].includes(arg) && runtime === "claude-code") continue;
    if (runtime === "codex" && arg === "resume") {
      // Only the resume selector is replaced; launch policies remain intact.
      if (args[i + 1] && !args[i + 1]!.startsWith("-")) i++;
      continue;
    }
    if (runtime === "codex" && ["--last", "--all"].includes(arg)) continue;
    next.push(arg);
  }
  return runtime === "codex" ? [...next, "resume", sessionId] : [...next, "--resume", sessionId];
}

/** Copy only the exact conversation and its attachments. Never auth files,
 * token stores, provider settings or a whole SQLite database. Existing target
 * conversation bytes are retained in a private rollback directory.
 */
export function stageConversation(sourceHome: string, target: SeatAccountHome, sessionId: string): string {
  if (!/^[a-f0-9-]{36}$/i.test(sessionId)) throw new Error("Native resume ID is invalid.");
  const directory = target.runtime === "codex" ? "sessions" : "projects";
  const root = path.join(sourceHome, directory);
  const matches: string[] = [];
  let visited = 0;
  const walk = (dir: string, depth: number) => {
    if (depth > 6 || ++visited > 20_000) throw new Error("Conversation lookup exceeded its bound.");
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(file, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(sessionId)) matches.push(file);
    }
  };
  walk(root, 0);
  const exact = matches.filter(file => target.runtime === "codex"
    ? path.basename(file).endsWith(`${sessionId}.jsonl`) : path.basename(file) === `${sessionId}.jsonl`);
  if (exact.length !== 1) throw new Error("An unambiguous native conversation was not found.");
  const source = exact[0]!;
  const destination = path.join(target.home, directory, path.relative(root, source));
  if (destination === source) return source;
  const backup = path.join(target.home, "openrig-conversation-backups", randomUUID());
  mkdirSync(path.dirname(destination), { recursive: true, mode: 0o700 });
  if (existsSync(destination)) { mkdirSync(backup, { recursive: true, mode: 0o700 }); copyFileSync(destination, path.join(backup, path.basename(destination))); }
  copyFileSync(source, destination);
  // Claude stores subagent transcripts and attachments beside the parent JSONL.
  const attachments = source.slice(0, -".jsonl".length);
  if (existsSync(attachments) && statSync(attachments).isDirectory()) {
    const targetAttachments = destination.slice(0, -".jsonl".length);
    if (existsSync(targetAttachments)) { mkdirSync(backup, { recursive: true, mode: 0o700 }); cpSync(targetAttachments, path.join(backup, sessionId), { recursive: true }); }
    cpSync(attachments, targetAttachments, { recursive: true, dereference: false });
  }
  return destination;
}
