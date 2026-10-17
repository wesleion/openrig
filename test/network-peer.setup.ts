import { vi } from "vitest";

// In-process fixture requests model the loopback CLI. Tests of remote boundaries
// pass an explicit environment; production refuses an unknown socket peer.
vi.mock("hono", async (importOriginal) => {
  const actual = await importOriginal<typeof import("hono")>();
  return { ...actual, Hono: class FixtureHono extends actual.Hono {
    constructor(...args: ConstructorParameters<typeof actual.Hono>) {
      super(...args);
      // Hono defines request on each instance; a prototype patch has no effect.
      const request = this.request;
      this.request = (input, init, env, executionContext) => request(input, init,
        env ?? { incoming: { socket: { remoteAddress: "127.0.0.1" } } }, executionContext);
    }
  } };
});
