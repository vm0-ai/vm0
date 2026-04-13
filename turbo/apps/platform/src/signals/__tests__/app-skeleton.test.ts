import { describe, it, expect, vi } from "vitest";
import { testContext } from "./test-helpers";
import { setupPage } from "../../__tests__/page-helper";
import {
  appSkeletonVisible$,
  hideAppSkeleton$,
  showAppSkeleton$,
  skeletonMessages$,
} from "../app-skeleton";

const context = testContext();

describe("showAppSkeleton$ restarts cycling (regression)", () => {
  it("after hide → show, the message cycle advances so the typewriter animation re-fires", async () => {
    await setupPage({ context, path: "/", withoutRender: true });

    // Forcibly stop the bootstrap cycling loop so we have a stable baseline.
    await context.store.set(hideAppSkeleton$, context.signal);
    expect(context.store.get(appSkeletonVisible$)).toBeFalsy();

    const cycleAfterHide = context.store.get(skeletonMessages$).cycle;

    // Show again — this must restart the cycling loop so <div key={cycle}>
    // remounts and the typewriter animation re-fires. Without the restart in
    // showAppSkeleton$ the loop stays aborted from the prior hide and the
    // cycle index is frozen forever.
    context.store.set(showAppSkeleton$);
    expect(context.store.get(appSkeletonVisible$)).toBeTruthy();

    await vi.waitFor(() => {
      expect(context.store.get(skeletonMessages$).cycle).toBeGreaterThan(
        cycleAfterHide,
      );
    });
  });
});
