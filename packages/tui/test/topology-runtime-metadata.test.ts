import {describe, it, expect} from "vitest";
import {renderGraphStyle} from "../src/topology/render-graph.js";
import {spikeFixtureGraph} from "../src/topology/fixture.js";

describe("runtime metadata inside rendered topology cards", () => {
  for(const style of ["hatchet","braille","braille-fallback"]) {
    it(`${style}: draws effort adjacent to the observed model, preserving runtime and context`, () => {
      const graph=spikeFixtureGraph();
      const node=graph.nodes.find(node=>node.data.logicalId==="orch.lead")!;
      node.data.runtimeMetadata={model:"claude-opus-5-5",effort:"low",source:"claude_transcript_jsonl",sampledAt:"2026-10-08T15:00:00Z"};
      const rows=renderGraphStyle(style,graph,{host:"local",rig:"lab"},400).plainLines();
      expect(rows.some(row=>row.includes("claude-opus-5-5 (low)")&&row.includes("18%"))).toBe(true);
      expect(rows.join("\n")).not.toContain("effort low");
    });
  }
});
