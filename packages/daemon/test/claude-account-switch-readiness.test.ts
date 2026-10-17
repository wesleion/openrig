import { describe, expect, it } from "vitest";
import { classifyPaneActivity } from "../src/domain/session-transport.js";
const frame = (text: string, work = "Completed response") => [work,
  "───────────────────────────── intake-lead@agency-sites ─", `❯ ${text}`,
  "────────────────────────────────────────────────────────",
  "  ⏵⏵ auto mode on (shift+tab to cycle) · ← for agents",
  "                ~190k uncached · /clear to start fresh",
  "                 ✔ Update installed · Restart to apply",
  "                new task? /clear to save 190.4k tokens"].join("\n");
describe("Claude account switch readiness on the observed native screen", () => {
  it("recognizes an empty auto-mode composer under current native informational footers", () => {
    expect(classifyPaneActivity(frame(""), { timerlessStatusIsLive: true }).state).toBe("agent_idle");
  });
  it("protects an unsent draft and a live compaction despite the same footer", () => {
    // 0.6.10 reads a draft above these unsupported informational footers as unknown, not prompt_draft
    // (#808 footer rules). The safety property is unchanged: a draft is never idle, so no switch proceeds.
    expect(classifyPaneActivity(frame("unsent text"), { timerlessStatusIsLive: true }).state).not.toBe("agent_idle");
    expect(classifyPaneActivity(frame("", "✻ Compacting conversation…"), { timerlessStatusIsLive: true }).state).toBe("agent_active");
  });
  it("does not turn footer text without a complete composer into idle evidence", () => {
    expect(classifyPaneActivity(frame("").split("\n").slice(-4).join("\n"), { timerlessStatusIsLive: true }).state).not.toBe("agent_idle");
  });
});
