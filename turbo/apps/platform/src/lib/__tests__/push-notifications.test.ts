import { describe, it, expect, vi, beforeEach } from "vitest";
import { createStore } from "ccstate";
import { registerServiceWorker$ } from "../push-notifications";

const { mockIsFeatureEnabled } = vi.hoisted(() => {
  return { mockIsFeatureEnabled: vi.fn() };
});

vi.mock("@vm0/core/feature-switch", () => {
  return { isFeatureEnabled: mockIsFeatureEnabled };
});

describe("registerServiceWorker$", () => {
  beforeEach(() => {
    mockIsFeatureEnabled.mockReset();
  });

  function setupServiceWorkerMocks() {
    const mockRegister = vi.fn().mockResolvedValue({});
    vi.stubGlobal("navigator", { serviceWorker: { register: mockRegister } });
    vi.stubGlobal("PushManager", {});
    return { mockRegister };
  }

  it("passes updateViaCache: none when PwaOfflineCache is enabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(true);
    const { mockRegister } = setupServiceWorkerMocks();

    const store = createStore();
    await store.set(registerServiceWorker$, AbortSignal.timeout(5000));

    expect(mockRegister).toHaveBeenCalledWith("/sw.js", {
      updateViaCache: "none",
    });
  });

  it("omits updateViaCache: none when PwaOfflineCache is disabled", async () => {
    mockIsFeatureEnabled.mockReturnValue(false);
    const { mockRegister } = setupServiceWorkerMocks();

    const store = createStore();
    await store.set(registerServiceWorker$, AbortSignal.timeout(5000));

    expect(mockRegister).toHaveBeenCalledWith("/sw.js", undefined);
  });
});
