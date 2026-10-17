import { describe, it, expect } from "vitest";
import { composeView } from "../src/domain/terminal/view-composer.js";
import { deriveViewMembers } from "../src/domain/terminal/terminal-views-store.js";
import { buildGridRoot, controllerStripRatio, planHerdrLayout, type HerdrLayoutNode } from "../src/domain/terminal/herdr-adapter.js";

const rows = [
  { canonicalSessionName: "executor@lab", attachmentType: "tmux", runtime: "claude-code", logicalId: "lab.executor" },
  { canonicalSessionName: "jev@lab", attachmentType: "tmux", runtime: "terminal", logicalId: "lab.jev",
    controller: { kind: "jev-flow", command: "'/node' '/registered/cli.js' watch --config '/registered/policy.json'" } },
  { canonicalSessionName: "revisor@lab", attachmentType: "tmux", runtime: "codex", logicalId: "lab.revisor" },
];
function leaves(node: HerdrLayoutNode): HerdrLayoutNode[] {
  return node.type === "pane" ? [node] : [...leaves(node.first), ...leaves(node.second)];
}
describe("Herdr agents and registered controller", () => {
  it("three agents share the top row above the full-width controller", () => {
    const members=deriveViewMembers([...rows,{canonicalSessionName:"lead@dev-core",attachmentType:"tmux",runtime:"codex",logicalId:"dev.lead"}]);
    const view=composeView("pod:dev-core/dev",members,{resolveHost:()=>null});
    const grid=buildGridRoot(view.opened);
    expect(grid).toMatchObject({columns:3,rows:2,blanks:0});
    expect(grid.root).toMatchObject({direction:"down",first:{direction:"right",ratio:1/3},second:{label:"lab.jev"}});
    expect(leaves(grid.root).map(p=>p.type==="pane"?p.label:"")).toEqual(["lab.executor","lab.revisor","dev.lead","lab.jev"]);
    expect(buildGridRoot(view.opened,4).root).toMatchObject({direction:"right"});
    const ordinary=view.opened.map(({controller:_controller,...p})=>p);
    expect(buildGridRoot(ordinary)).toMatchObject({columns:2,rows:2,blanks:0});
  });
  it("derived pod retains native agent attaches and observes Jev without changing its tmux shell", () => {
    const members = deriveViewMembers(rows);
    const view = composeView("pod:openrig-lab/lab", members, { resolveHost: () => null, localTmux: "/usr/bin/tmux" });
    expect(view.opened.map(p => p.paneCommand)).toEqual([
      "'/usr/bin/tmux' attach -t 'executor@lab'", rows[1]!.controller!.command,
      "'/usr/bin/tmux' attach -t 'revisor@lab'",
    ]);
    expect(view.opened[1]).toMatchObject({ controller: "jev-flow", readOnly: true });
    const grid = buildGridRoot(view.opened);
    expect(grid.blanks).toBe(0); expect(leaves(grid.root)).toHaveLength(3);
    expect(grid.root).toMatchObject({ type: "split", direction: "down", ratio: controllerStripRatio(33),
      first: { type: "split", direction: "right", ratio: 0.5,
        first: { label: "lab.executor" }, second: { label: "lab.revisor" } },
      second: { type: "pane", label: "lab.jev" } });
    expect(planHerdrLayout(view, "test").pages[0]?.root).toEqual(grid.root);
  });
  it("explicit columns and ordinary terminal seats keep the existing grid", () => {
    const view = composeView("v", deriveViewMembers(rows), { resolveHost: () => null });
    expect(buildGridRoot(view.opened, 3).root).toMatchObject({ direction: "right" });
    const ordinary = view.opened.map(({ controller: _controller, ...p }) => p);
    expect(buildGridRoot(ordinary).blanks).toBe(1);
  });
  it("unavailable registration is a named absence rather than an empty tool shell", () => {
    const broken = rows.map(r => r.controller ? { ...r, controller: { kind: "jev-flow", command: null } } : r);
    const view = composeView("v", deriveViewMembers(broken), { resolveHost: () => null });
    expect(view.opened).toHaveLength(2);
    expect(view.absent).toEqual([{ seat: "jev@lab", host: null, reason: "registered controller monitor unavailable" }]);
  });
  it("local monitor commands never run for remote view members", () => {
    const members = deriveViewMembers(rows, { host: "edge", readOnly: true });
    const view = composeView("v", members, { resolveHost: () => ({ id: "edge", transport: "ssh", target: "host" }) });
    expect(view.opened.every(p => !p.controller && p.paneCommand.startsWith("ssh "))).toBe(true);
  });
});
