import {describe,it,expect} from "vitest";
import {layoutGraph} from "../src/topology/layout.js";
import {renderGraphStyle} from "../src/topology/render-graph.js";
import {spikeFixtureGraph} from "../src/topology/fixture.js";

describe("responsive graph preserves all members and containment",()=>{
  for(const width of [32,44,70,100,140,240]) {
    it(`fits a ${width}-column content pane without hiding pods or overlapping cards`,()=>{
      const graph=spikeFixtureGraph();
      for(const node of graph.nodes.filter(node=>node.type==="rigNode"))node.data.runtimeMetadata={
        model:node.data.runtime==="codex"?"gpt-6.1-sol":"claude-opus-5-5",effort:"default",effortDefault:"low",source:"native",sampledAt:null};
      const layout=layoutGraph(graph,width,"lab");
      expect(layout.clipped).toBe(false);
      expect(layout.placed).toHaveLength(graph.nodes.filter(node=>node.type==="rigNode").length);
      for(const card of layout.placed) {
        expect(card.x).toBeGreaterThanOrEqual(0);
        expect(card.x+card.w).toBeLessThanOrEqual(width);
        expect(card.metaLines?.every(line=>line.length<=card.w-4)).toBe(true);
        const pod=layout.containers.find(container=>container.kind==="pod"&&container.name===card.node.data.podNamespace)!;
        expect(card.x).toBeGreaterThan(pod.x);
        expect(card.y).toBeGreaterThan(pod.y);
        expect(card.x+card.w).toBeLessThan(pod.x+pod.w);
        expect(card.y+card.h).toBeLessThan(pod.y+pod.h);
      }
      for(let i=0;i<layout.placed.length;i++)for(let j=i+1;j<layout.placed.length;j++) {
        const a=layout.placed[i]!,b=layout.placed[j]!;
        expect(a.x+a.w<=b.x||b.x+b.w<=a.x||a.y+a.h<=b.y||b.y+b.h<=a.y).toBe(true);
      }
    });
  }
  it("keeps model and default label together in narrow cards for every style",()=>{
    const graph=spikeFixtureGraph();
    const node=graph.nodes.find(node=>node.data.logicalId==="dev.qa")!;
    node.data.runtimeMetadata={model:"gpt-6.1-sol",effort:"default",source:"native",sampledAt:null};
    for(const style of ["hatchet","braille","braille-fallback"]) {
      const lines=renderGraphStyle(style,graph,{host:"local",rig:"lab"},44).plainLines().join("\n");
      expect(lines).toContain("gpt-6.1-sol (padrão)");
      expect(lines).not.toContain("content clipped");
      for(const pod of ["orch","dev","review"])expect(lines).toContain(`≡ ${pod}`);
    }
  });
  it("rewraps when the viewport grows without losing canonical action targets",()=>{
    const graph=spikeFixtureGraph(),narrow=layoutGraph(graph,44),wide=layoutGraph(graph,400);
    expect(narrow.height).toBeGreaterThan(wide.height);
    expect(narrow.placed.map(card=>card.node.id).sort()).toEqual(wide.placed.map(card=>card.node.id).sort());
  });
});
