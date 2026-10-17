import { describe, expect, it } from "vitest";
import { elapsedLabel, hasRuntimeClock, runtimeMetricFields, stateWithElapsed } from "../src/runtime-metrics.js";
import { demoSnapshot } from "../src/demo-data.js";
import { createViewState } from "../src/state.js";
import { renderScreen } from "../src/render.js";
import type { AgentRow } from "../src/types.js";

const epoch = Date.parse("2026-10-08T16:00:00Z");
function fixture() {
  const snapshot = demoSnapshot();
  const agent: AgentRow = { name: "team.codex", runtime: "codex", spec: "", context: 12, tokens: "123",
    status: "idle", live: true, nodeKind: "agent", nodeId: "agent-id", rigId: "lab-id",
    activityStateChangedAt: new Date(epoch).toISOString(),
    contextUsage: { availability: "known", usedPercentage: 12, contextWindowSize: 1000,
      totalInputTokens: 900, totalOutputTokens: 50, totalCachedInputTokens: 600,
      lastInference: { inputTokens: 120, outputTokens: 3, totalTokens: 123, cachedInputTokens: 0, at: new Date(epoch).toISOString() },
      execution: { startedAt: new Date(epoch - 30000).toISOString(), completedAt: new Date(epoch).toISOString(),
        lastModelResponseAt: new Date(epoch - 1000).toISOString(), source: "native_rollout" } } };
  snapshot.hosts[0]!.rigs = [{ name: "lab", id: "lab-id", pods: [{ name: "team", agents: [agent] }] }];
  const view = createViewState({ instanceId: "test", getSnapshot: () => snapshot });
  view.dispatch({ type: "drill", resource: "rig", name: "lab" });
  return { snapshot, agent, view };
}

describe("native runtime metrics", () => {
  it("elapsed duration uses a stable native timestamp; invalid or future timestamps stay unknown", () => {
    const { agent } = fixture();
    expect(stateWithElapsed(agent, "idle", epoch + 5000, 11)).toBe("idle 5s");
    expect(stateWithElapsed(agent, "idle", epoch + 65000, 11)).toBe("idle 1m5s");
    expect(elapsedLabel("invalid", epoch)).toBe("—");
    expect(elapsedLabel(new Date(epoch + 1).toISOString(), epoch)).toBe("—");
    agent.activityStateChangedAt = null;
    agent.contextUsage = undefined;
    expect(stateWithElapsed(agent, "idle", epoch + 5000, 11)).toBe("idle —");
  });

  it("working duration fits a narrow STATE column and does not use an idle completion as its start", () => {
    const { agent } = fixture();
    agent.status = "active"; agent.activityStateChangedAt = null;
    agent.activityStartedAt = new Date(epoch).toISOString();
    expect(stateWithElapsed(agent, "working", epoch + 15000, 9)).toBe("work 15s");
    agent.activityStartedAt = null;
    expect(stateWithElapsed(agent, "working", epoch + 15000, 11)).toBe("working —");
  });

  it("state duration ignores later input/source changes and uses a completed native idle turn", () => {
    const { agent } = fixture();
    agent.activityStartedAt = new Date(epoch - 2000).toISOString();
    agent.activityStateChangedAt = new Date(epoch + 4000).toISOString();
    expect(stateWithElapsed(agent, "idle", epoch + 5000, 11)).toBe("idle 5s");
    agent.status = "active";
    expect(stateWithElapsed(agent, "working", epoch + 5000, 12)).toBe("working 7s");
  });

  it("last-inference cache and session cache stay distinct, including a genuine zero", () => {
    const { agent } = fixture();
    const fields = Object.fromEntries(runtimeMetricFields(agent, epoch + 5000).map(field => [field.label, field.value]));
    expect(fields["last input"]).toBe("120"); expect(fields["last output"]).toBe("3");
    expect(fields["last cache"]).toBe("0"); expect(fields["session cache"]).toBe("600");
    expect(fields["last finish"]).toMatch(/^5s/); expect(fields["last response"]).toMatch(/^6s/);
    expect(fields["cache basis"]).toContain("does not prove cache validity");
  });

  it("idle table keeps a one-second runtime clock active without new observations", () => {
    const { agent, snapshot, view } = fixture();
    const first = renderScreen(view.get(), snapshot, { cols: 140, rows: 40, nowMs: epoch + 5000 });
    const second = renderScreen(view.get(), snapshot, { cols: 140, rows: 40, nowMs: epoch + 15000 });
    expect(first.lines.join("\n")).toContain("idle 5s");
    expect(second.lines.join("\n")).toContain("idle 15s");
    expect(second.runtimeClockActive).toBe(true);
    agent.activityStateChangedAt = null; agent.contextUsage = undefined;
    expect(hasRuntimeClock(agent, epoch + 15000)).toBe(false);
  });

  it("tool details expose three native mode actions without presenting an agent queue", () => {
    const { agent, snapshot, view } = fixture();
    agent.nodeKind = "infrastructure"; agent.runtime = "terminal";
    agent.controller = { kind: "jev-flow", config: "/lab/policy.json", mode: "observe", revision: 4, available: true };
    view.dispatch({ type: "drill", resource: "agent", name: agent.name,
      target: { host: snapshot.hosts[0]!.name, rig: "lab", pod: "team" } });
    const screen = renderScreen(view.get(), snapshot, { cols: 140, rows: 80, nowMs: epoch + 5000 });
    const actions = screen.hitMap.map(hit => hit.action).filter(action => action.type === "act" && action.act === "controller-mode");
    expect(actions).toHaveLength(3);
    expect(actions.map(action => action.type === "act" && action.act === "controller-mode" ? action.mode : null)).toEqual(["off", "observe", "apply"]);
    expect(screen.lines.join("\n")).not.toContain("CURRENT WORK");
  });
});
