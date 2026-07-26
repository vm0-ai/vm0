import { screen, waitFor } from "@testing-library/react";
import {
  zeroBrowserContract,
  type ZeroBrowserSession,
} from "@vm0/api-contracts/contracts/zero-browser";
import { describe, expect, it } from "vitest";

import {
  detachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";

const context = testContext();

const browserId = "c0000000-0000-4000-a000-000000000091";
const liveUrl = "https://live.browser-use.com/?wss=test-browser-page-token";

function browserSession(
  overrides: Partial<ZeroBrowserSession> = {},
): ZeroBrowserSession {
  return {
    id: browserId,
    name: "booking",
    status: "active",
    viewerUrl: `https://app.vm0.ai/browsers/${browserId}`,
    liveUrl,
    proxyCountryCode: null,
    timeoutMinutes: 240,
    maxCredits: 500,
    grossCredits: 12,
    creditsCharged: 12,
    idleExpiresAt: "2026-07-24T10:10:00.000Z",
    suspendedAt: null,
    suspensionReason: null,
    createdAt: "2026-07-24T10:00:00.000Z",
    updatedAt: "2026-07-24T10:00:00.000Z",
    ...overrides,
  };
}

describe("browser session page", () => {
  it("loads the authenticated live viewer and keeps the browser leased while it is open", async () => {
    let leaseRequests = 0;
    context.mocks.api(zeroBrowserContract.get, ({ params, query, respond }) => {
      expect(params.browserId).toBe(browserId);
      expect(query.chatThreadId).toBeUndefined();
      return respond(200, { browser: browserSession() });
    });
    context.mocks.api(zeroBrowserContract.leaseById, ({ params, respond }) => {
      expect(params.browserId).toBe(browserId);
      leaseRequests += 1;
      return respond(200, { browser: browserSession() });
    });

    detachedSetupPage({
      context,
      path: `/browsers/${browserId}`,
    });

    const frame = await screen.findByTitle("Live browser: booking");
    expect(frame).toHaveAttribute("src", liveUrl);
    expect(frame).toHaveAttribute("referrerpolicy", "no-referrer");
    await waitFor(() => {
      expect(leaseRequests).toBeGreaterThan(0);
    });
  });

  it("offers a resume that restarts a reclaimed browser", async () => {
    let getRequests = 0;
    context.mocks.api(zeroBrowserContract.get, ({ respond }) => {
      getRequests += 1;
      return respond(200, {
        browser: browserSession({
          status: "suspended",
          liveUrl: null,
          suspendedAt: "2026-07-24T10:12:00.000Z",
          suspensionReason: "idle",
          idleExpiresAt: null,
        }),
      });
    });
    let resumeRequests = 0;
    context.mocks.api(zeroBrowserContract.resumeById, ({ params, respond }) => {
      expect(params.browserId).toBe(browserId);
      resumeRequests += 1;
      return respond(200, { browser: browserSession() });
    });
    context.mocks.api(zeroBrowserContract.leaseById, ({ respond }) => {
      return respond(200, { browser: browserSession() });
    });

    detachedSetupPage({
      context,
      path: `/browsers/${browserId}`,
    });

    const resume = await waitFor(() => {
      const button = queryAllByRoleFast("button").find((candidate) => {
        return candidate.textContent === "Resume browser";
      });
      expect(button).toBeDefined();
      return button;
    });
    expect(getRequests).toBeGreaterThan(0);
    resume?.click();

    const frame = await screen.findByTitle("Live browser: booking");
    expect(frame).toHaveAttribute("src", liveUrl);
    expect(resumeRequests).toBe(1);
  });
});
