import { screen } from "@testing-library/react";
import {
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { describe, expect, it } from "vitest";

import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

describe("browser session page", () => {
  it("loads the authenticated live viewer from a browser universal link", async () => {
    const browserId = "c0000000-0000-4000-a000-000000000091";
    const liveUrl = "https://live.browser-use.com/?wss=test-browser-page-token";
    const browser: ZeroBrowserSession = {
      id: browserId,
      name: "booking",
      status: "active",
      viewerUrl: `https://app.vm0.ai/browsers/${browserId}`,
      liveUrl,
      proxyCountryCode: null,
      timeoutMinutes: 30,
      maxCredits: 500,
      grossCredits: 12,
      creditsCharged: 12,
      suspendedAt: null,
      suspensionReason: null,
      createdAt: "2026-07-24T10:00:00.000Z",
      updatedAt: "2026-07-24T10:00:00.000Z",
    };
    context.mocks.api(zeroBrowserContract.get, ({ params, query, respond }) => {
      expect(params.browserId).toBe(browserId);
      expect(query.chatThreadId).toBeUndefined();
      return respond(200, { browser });
    });

    detachedSetupPage({
      context,
      path: `/browsers/${browserId}`,
    });

    const frame = await screen.findByTitle("Live browser: booking");
    expect(frame).toHaveAttribute("src", liveUrl);
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    expect(screen.getByText("12 credits charged")).toBeInTheDocument();
  });
});
