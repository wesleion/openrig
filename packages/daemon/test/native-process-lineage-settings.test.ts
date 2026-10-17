import { describe, expect, it } from "vitest";
import { verifyClaudePaneProcess, type NativeProcessRow } from "../src/domain/native-process-lineage.js";

const token = "00000000-0000-7000-8000-000000000001";
const settings = JSON.stringify({ permissions: { allow: ["Bash(claude auth status:*)", "Bash(rig queue list:*)"] } });
const check = (command: string) => verifyClaudePaneProcess({
  target: "%1", expectedToken: token, tmux: { getPanePid: async () => 10 },
  listProcesses: (): NativeProcessRow[] => [
    { pid: 10, ppid: 1, pgid: 10, tpgid: 11, executableName: "bash", command: "-bash", startedAt: "Thu Oct 8 20:00:00 2026" },
    { pid: 11, ppid: 10, pgid: 11, tpgid: 11, executableName: "claude", command, startedAt: "Thu Oct 8 20:00:01 2026" },
  ],
});

describe("Claude identity with ps-flattened JSON settings", () => {
  it("proves the exact resumed conversation with spaces inside permissions", async () => {
    expect((await check(`/home/user/.local/bin/claude --permission-mode acceptEdits --settings ${settings} --resume ${token} --name advisor-lead@kernel`))?.process.pid).toBe(11);
  });
  it("proves fresh identity with nested arrays and escaped quotes", async () => {
    const json = JSON.stringify({ env: { note: 'text with "quotes" and a \\ slash' }, permissions: { allow: ["Bash(rig queue list:*)"] } });
    expect(await check(`claude --settings ${json} --session-id ${token}`)).not.toBeNull();
  });
  it("keeps quoted settings and file settings working", async () => {
    expect(await check(`claude --settings '${settings}' --resume ${token}`)).not.toBeNull();
    expect(await check(`claude --settings /tmp/settings.json --resume ${token}`)).not.toBeNull();
  });
  it("handles the equals form without exposing JSON contents as arguments", async () => {
    expect(await check(`claude --settings=${settings} --resume ${token}`)).not.toBeNull();
    expect(await check(`claude --settings=${JSON.stringify({ note: `--resume ${token}` })}`)).toBeNull();
  });
  it("does not accept an identity embedded only inside settings", async () => {
    expect(await check(`claude --settings ${JSON.stringify({ note: `--resume ${token}` })}`)).toBeNull();
  });
  it("refuses another conversation even when settings contain the expected ID", async () => {
    expect(await check(`claude --settings ${JSON.stringify({ note: `--resume ${token}` })} --resume another`)).toBeNull();
  });
  it("refuses malformed settings instead of finding a later token", async () => {
    expect(await check(`claude --settings {"broken":} --resume ${token}`)).toBeNull();
    expect(await check(`claude --settings {"broken":"unterminated --resume ${token}`)).toBeNull();
  });
  it("still refuses unknown arguments and duplicate identities", async () => {
    expect(await check(`claude --settings ${settings} --resume ${token} arbitrary-prompt`)).toBeNull();
    expect(await check(`claude --settings ${settings} --resume ${token} --session-id ${token}`)).toBeNull();
  });
});
