// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ControllerModeControl, RuntimeMetricsDetails, type ControllerView } from "../src/components/ControllerControls.js";
import { MISSION_CONTROL_BEARER_STORAGE_KEY, TERMINAL_BEARER_STORAGE_KEY } from "../src/components/mission-control/missionControlAuth.js";

const selection = vi.hoisted(() => ({ host: "local" }));
vi.mock("../src/hooks/useHosts.js", () => ({ useSelectedHostId: () => selection.host }));
const clients: QueryClient[] = [];
beforeEach(() => { selection.host = "local"; localStorage.clear(); });
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals(); });
const binding: ControllerView = { kind: "jev-flow", config: "/lab/policy.json", available: true, mode: "observe", revision: 4 };
function mount(controller: ControllerView = binding, readOnly = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  clients.push(client);
  const element = (value: ControllerView) => <QueryClientProvider client={client}>
    <ControllerModeControl rigId="lab" nodeId="tool" controller={value} readOnly={readOnly} />
  </QueryClientProvider>;
  const mounted = render(element(controller));
  return { ...mounted, rerenderStatus: (value: ControllerView) => mounted.rerender(element(value)) };
}

describe("native controller mode UI", () => {
  it("sends operator credentials, native node identity and expected revision; newer graph props remain authoritative", async () => {
    localStorage.setItem(MISSION_CONTROL_BEARER_STORAGE_KEY, "operator-fixture");
    localStorage.setItem(TERMINAL_BEARER_STORAGE_KEY, "terminal-fixture");
    const fetch = vi.fn(async () => new Response(JSON.stringify({ ...binding, mode: "off", revision: 5 }), { status: 200 }));
    vi.stubGlobal("fetch", fetch); const mounted = mount();
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "off" } });
    await waitFor(() => expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("off"));
    expect(fetch).toHaveBeenCalledTimes(1);
    const [url, options] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/rigs/lab/controllers/tool");
    expect((options.headers as Record<string, string>).Authorization).toBe("Bearer operator-fixture");
    expect(JSON.parse(String(options.body))).toEqual({ mode: "off", expectedRevision: 4 });
    mounted.rerenderStatus({ ...binding, revision: 4 });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("off");
    mounted.rerenderStatus({ ...binding, mode: "apply", revision: 6 });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("apply");
  });

  it.each(["remote", "read-only", "unknown-registration"])("%s controls never send a write", async variant => {
    const fetch = vi.fn(); vi.stubGlobal("fetch", fetch);
    if (variant === "remote") selection.host = "remote-host";
    mount(variant === "unknown-registration" ? { ...binding, available: undefined } : binding, variant === "read-only");
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "apply" } });
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([{}, null, { ...binding, mode: "shell" }, { ...binding, revision: 3 }])("malformed or stale success cannot replace status or authorize retries: %j", async body => {
    const fetch = vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })); vi.stubGlobal("fetch", fetch);
    mount(); fireEvent.change(screen.getByRole("combobox"), { target: { value: "off" } });
    await screen.findByRole("alert");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("observe");
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox"), { target: { value: "apply" } });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("a stale CAS rejection preserves mode until a refreshed status arrives", async () => {
    const fetch = vi.fn(async () => new Response(JSON.stringify({ error: "stale_mode_revision" }), { status: 409 })); vi.stubGlobal("fetch", fetch);
    const mounted = mount(); fireEvent.change(screen.getByRole("combobox"), { target: { value: "off" } });
    expect((await screen.findByRole("alert")).textContent).toContain("stale_mode_revision");
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("observe");
    mounted.rerenderStatus({ ...binding, mode: "apply", revision: 5 });
    expect((screen.getByRole("combobox") as HTMLSelectElement).value).toBe("apply");
    expect((screen.getByRole("combobox") as HTMLSelectElement).disabled).toBe(false);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("metrics open in a portal without extending the graph card", async () => {
    const mounted = render(<div data-testid="card"><RuntimeMetricsDetails contextUsage={{ availability: "known", usedPercentage: 12,
      lastInference: { inputTokens: 120, outputTokens: 3, totalTokens: 123, cachedInputTokens: 0, at: null }, totalCachedInputTokens: 600 }} /></div>);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Contexto e tempo" }));
    const overlay = await screen.findByRole("dialog");
    expect(mounted.getByTestId("card").contains(overlay)).toBe(false);
    expect(overlay.textContent).toContain("120 entrada / 3 saída");
    expect(overlay.textContent).toContain("0 (0.0%)");
    expect(overlay.textContent).toContain("Tempo parado não garante validade do cache");
  });
});
