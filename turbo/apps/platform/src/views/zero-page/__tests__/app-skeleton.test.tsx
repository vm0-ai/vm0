import { screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const APP_SKELETON_VISIBLE_EVENT = "vm0:app-skeleton-visible";
const APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY =
  "vm0AppSkeletonVisibleEventQueued";

const context = testContext();

describe("app skeleton", () => {
  it("dispatches one visible event after the skeleton mounts", async () => {
    delete document.documentElement.dataset[
      APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY
    ];
    context.signal.addEventListener("abort", () => {
      delete document.documentElement.dataset[
        APP_SKELETON_VISIBLE_EVENT_QUEUED_KEY
      ];
    });

    let eventCount = 0;
    let skeletonMountedAtDispatch = false;
    window.addEventListener(
      APP_SKELETON_VISIBLE_EVENT,
      () => {
        eventCount += 1;
        skeletonMountedAtDispatch =
          document.querySelector('[data-testid="app-skeleton"]') !== null;
      },
      { signal: context.signal },
    );

    detachedSetupPage({ context, path: "/_/skeleton" });

    await screen.findAllByTestId("app-skeleton");
    await waitFor(() => {
      expect(eventCount).toBe(1);
    });
    expect(skeletonMountedAtDispatch).toBeTruthy();
  });
});
