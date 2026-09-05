import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { startPlatformEntrypoint } from "../lib/platform-entrypoint.ts";
import { testContext } from "../signals/__tests__/test-helpers.ts";

const context = testContext();
const GOOGLE_TAG_SCRIPT_URL =
  "https://www.googletagmanager.com/gtag/js?id=AW-18144854014";

let googleAdsRequestedAfterApplicationStart = false;
async function waitForApplicationStart(): Promise<void> {
  await waitFor(() => {
    expect(document.getElementById("root")?.childElementCount).toBeGreaterThan(
      0,
    );
  });
}

async function stopApplication(): Promise<void> {
  window.dispatchEvent(new Event("pagehide"));
  await waitFor(() => {
    expect(document.querySelector(".okou-app")).toBeNull();
  });
}

describe("platform entrypoint", () => {
  beforeEach(async () => {
    googleAdsRequestedAfterApplicationStart = false;
    context.mocks.browser.url("https://app.vm0.ai/");
    context.mocks.clerk();
    context.mocks.posthog();
    context.mocks.sentry();
    const root = document.createElement("div");
    root.id = "root";
    document.body.replaceChildren(root);

    const addEventListener = vi.spyOn(window, "addEventListener");
    const appendChild = document.head.appendChild.bind(document.head);
    vi.spyOn(document.head, "appendChild").mockImplementation(
      <T extends Node>(node: T): T => {
        if (
          node instanceof HTMLScriptElement &&
          node.src === GOOGLE_TAG_SCRIPT_URL
        ) {
          googleAdsRequestedAfterApplicationStart =
            addEventListener.mock.calls.some(([eventName]) => {
              return eventName === "pagehide";
            });
        }
        return appendChild(node);
      },
    );

    startPlatformEntrypoint();
    await waitForApplicationStart();
  });

  afterEach(stopApplication);

  it("starts the application before requesting Google Ads", () => {
    expect(googleAdsRequestedAfterApplicationStart).toBeTruthy();
  });
});
