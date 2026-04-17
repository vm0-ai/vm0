import { describe, it, expect, vi } from "vitest";
import { testContext } from "./test-helpers";
import { setupPage } from "../../__tests__/page-helper";
import {
  appSkeletonVisible$,
  hideAppSkeleton$,
  showAppSkeleton$,
  startSkeletonCycling$,
  skeletonMessages$,
} from "../app-skeleton";
import { detach, Reason } from "../utils";

const context = testContext();

describe("showAppSkeleton$ + startSkeletonCycling$ restart cycling (regression)", () => {
  it("after hide → show + start, the message cycle advances so the typewriter animation re-fires", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    // Forcibly stop the bootstrap cycling loop so we have a stable baseline.
    await context.store.set(hideAppSkeleton$, context.signal);
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();

    const cycleAfterHide = context.store.get(skeletonMessages$).cycle;

    // Show again and re-launch cycling — callers (e.g. onboarding commands)
    // are responsible for restarting cycling in parallel with their own
    // async work via `Promise.all([set(startSkeletonCycling$, signal), …])`.
    // We simulate that here with detach() so the cycling promise does not
    // block the test.
    context.store.set(showAppSkeleton$);
    detach(
      context.store.set(startSkeletonCycling$, context.signal),
      Reason.Daemon,
    );
    expect(context.store.get(appSkeletonVisible$)).toBeTruthy();

    await vi.waitFor(() => {
      expect(context.store.get(skeletonMessages$).cycle).toBeGreaterThan(
        cycleAfterHide,
      );
    });
  });
});
