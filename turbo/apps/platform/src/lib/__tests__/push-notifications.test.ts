import { describe, it, expect, vi } from "vitest";
import { createStore } from "ccstate";

const { registerServiceWorker$ } = await import("../push-notifications");

describe("registerServiceWorker$", () => {
  function setupServiceWorkerMocks() {
    const mockRegister = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { serviceWorker: { register: mockRegister } });
    vi.stubGlobal("PushManager", {});
    return { mockRegister };
  }

  it("passes updateViaCache: none when registering the service worker", async () => {
    const { mockRegister } = setupServiceWorkerMocks();

    const store = createStore();
    await store.set(registerServiceWorker$, AbortSignal.timeout(5000));

    expect(mockRegister).toHaveBeenCalledWith("/sw.js", {
      updateViaCache: "none",
    });
  });
});
