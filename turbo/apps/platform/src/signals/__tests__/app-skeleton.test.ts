import { describe, it, expect, vi } from "vitest";
import { createStore } from "ccstate";
import {
  startSkeletonCycling$,
  skeletonMessages$,
  setCycleDelaysMs$,
} from "../app-skeleton.ts";

describe("startSkeletonCycling$", () => {
  it("should advance the cycle count after cycling fires", async () => {
    const store = createStore();
    store.set(setCycleDelaysMs$, 0, 0);

    const before = store.get(skeletonMessages$).cycle;

    const abortController = new AbortController();
    const cyclingPromise = store.set(
      startSkeletonCycling$,
      abortController.signal,
    );

    // Wait for at least one cycle to advance the count.
    await vi.waitFor(() => {
      expect(store.get(skeletonMessages$).cycle).toBeGreaterThan(before);
    });

    abortController.abort();
    await expect(cyclingPromise).rejects.toThrow();
  });

  it("should set isFirst to false after first cycle", async () => {
    const store = createStore();
    store.set(setCycleDelaysMs$, 0, 0);

    expect(store.get(skeletonMessages$).isFirst).toBeTruthy();

    const abortController = new AbortController();
    const cyclingPromise = store.set(
      startSkeletonCycling$,
      abortController.signal,
    );

    await vi.waitFor(() => {
      expect(store.get(skeletonMessages$).isFirst).toBeFalsy();
    });

    abortController.abort();
    await expect(cyclingPromise).rejects.toThrow();
  });
});
