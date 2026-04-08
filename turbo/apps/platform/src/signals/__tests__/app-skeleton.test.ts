import { describe, it, expect, vi } from "vitest";
import { createStore } from "ccstate";
import { http, HttpResponse } from "msw";
import { server } from "../../mocks/server.ts";
import { testContext } from "./test-helpers.ts";
import { setupPage } from "../../__tests__/page-helper.ts";
import {
  startSkeletonCycling$,
  skeletonMessages$,
  appSkeletonVisible$,
  hideAppSkeleton$,
  setCycleDelaysMs$,
} from "../app-skeleton.ts";

const context = testContext();

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

  it("should abort cleanly when signal is aborted before first cycle", async () => {
    const store = createStore();
    // Use large delays so no cycle fires before abort
    store.set(setCycleDelaysMs$, 60_000, 60_000);

    const abortController = new AbortController();
    const cyclingPromise = store.set(
      startSkeletonCycling$,
      abortController.signal,
    );

    abortController.abort();

    await expect(cyclingPromise).rejects.toThrow();
  });
});

describe("hideAppSkeleton$", () => {
  it("should hide the skeleton and cancel cycling", async () => {
    server.use(
      http.get("*/api/zero/org/agents/chat-agent", () => {
        return HttpResponse.json(null);
      }),
    );

    await setupPage({ context, path: "/", withoutRender: true });

    expect(context.store.get(appSkeletonVisible$)).toBeTruthy();

    await context.store.set(hideAppSkeleton$, context.signal);

    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();
  });
});
