import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStore } from "ccstate";

const { setEnabled, getEnabled } = vi.hoisted(() => {
  let enabled = false;
  return {
    setEnabled: (v: boolean) => {
      enabled = v;
    },
    getEnabled: () => {
      return enabled;
    },
  };
});

vi.mock("../../signals/external/feature-switch.ts", async () => {
  const { computed } = await import("ccstate");
  return {
    pwaOfflineCacheEnabled$: computed(() => {
      return getEnabled();
    }),
  };
});

const { registerServiceWorker$ } = await import("../push-notifications");

describe("registerServiceWorker$", () => {
  beforeEach(() => {
    setEnabled(false);
  });

  function setupServiceWorkerMocks() {
    const mockRegister = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { serviceWorker: { register: mockRegister } });
    vi.stubGlobal("PushManager", {});
    return { mockRegister };
  }

  it("passes updateViaCache: none when PwaOfflineCache is enabled", async () => {
    setEnabled(true);
    const { mockRegister } = setupServiceWorkerMocks();

    const store = createStore();
    await store.set(registerServiceWorker$, AbortSignal.timeout(5000));

    expect(mockRegister).toHaveBeenCalledWith("/sw.js", {
      updateViaCache: "none",
    });
  });

  it("omits updateViaCache: none when PwaOfflineCache is disabled", async () => {
    setEnabled(false);
    const { mockRegister } = setupServiceWorkerMocks();

    const store = createStore();
    await store.set(registerServiceWorker$, AbortSignal.timeout(5000));

    expect(mockRegister).toHaveBeenCalledWith("/sw.js", undefined);
  });
});
