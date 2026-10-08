import { describe, it, expect } from "vitest";
import { resolveSeatRoute } from "../src/lib/seat-route.js";
describe("seat navigation", () => {
  const rigs = [{ id: "rig-1", name: "kernel" }];
  const nodes = [{ nodeId: "node-1", logicalId: "advisor.agent", canonicalSessionName: "advisor-agent@kernel" }];
  const read = async <T>(url: string): Promise<T> => (url.includes("summary") ? rigs : nodes) as T;
  it("normalizes rig names and canonical seat stems without changing logical IDs", async () => {
    expect(await resolveSeatRoute({ rigId: "kernel", logicalId: "advisor-agent" }, read)).toEqual({ rigId: "rig-1", logicalId: "advisor.agent" });
    expect(await resolveSeatRoute({ rigId: "rig-1", logicalId: "node-1" }, read)).toEqual({ rigId: "rig-1", logicalId: "advisor.agent" });
    expect(await resolveSeatRoute({ rigId: "kernel", logicalId: "advisor-agent%40kernel" }, read)).toEqual({ rigId: "rig-1", logicalId: "advisor.agent" });
  });
  it("refuses ambiguity instead of opening another rig", async () => {
    const duplicate = async <T>(): Promise<T> => [...rigs, { id: "rig-2", name: "kernel" }] as T;
    await expect(resolveSeatRoute({ rigId: "kernel", logicalId: "advisor-agent" }, duplicate)).rejects.toThrow("Ambiguous rig");
  });
});
