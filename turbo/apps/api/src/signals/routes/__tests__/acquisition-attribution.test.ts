import { randomUUID } from "node:crypto";

import { acquisitionAttributionContract } from "@okouai/api-contracts/contracts/acquisition-attribution";
import { describe, expect, it } from "vitest";

import { accept, testContext } from "../../../__tests__/test-context";
import { setupApp } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { createRouteMocks } from "./helpers/route-test";
import { acquisitionAttributionRoutes } from "../acquisition-attribution";

const context = testContext();
const mocks = createRouteMocks(context);

const RECORDED_AT_ISO = "2026-05-30T12:00:00.000Z";

class ClerkApiResponseTestError extends Error {
  static readonly kind = "ClerkAPIResponseError";
  readonly status = 429;

  constructor(readonly retryAfter: number) {
    super("Clerk Backend API rate limit exceeded");
  }
}

function client() {
  return setupApp({ context, routes: acquisitionAttributionRoutes })(
    acquisitionAttributionContract,
  );
}

describe("POST /api/attribution/signup", () => {
  it("requires a Clerk session", async () => {
    const response = await client().recordSignup({
      body: {
        attribution: {
          vm0_source: "presentation",
        },
      },
    });

    expect(response.status).toBe(401);
  });

  it("writes first-touch attribution to Clerk private metadata", async () => {
    mockNow(new Date(RECORDED_AT_ISO));
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: userId,
          privateMetadata: {
            existing: "value",
          },
        },
      ],
    });
    context.mocks.clerk.users.updateUserMetadata.mockResolvedValue({});

    const response = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            vm0_source: "presentation",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "presentation_search_en",
            vm0_experiment: "presentation_lp",
            vm0_variant: "a",
            gclid: "test-gclid",
            gclid_present: "true",
          },
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ recorded: true });
    expect(context.mocks.clerk.users.updateUserMetadata).toHaveBeenCalledWith(
      userId,
      {
        privateMetadata: {
          existing: "value",
          signup_attribution: {
            vm0_source: "presentation",
            utm_source: "google",
            utm_medium: "cpc",
            utm_campaign: "presentation_search_en",
            vm0_experiment: "presentation_lp",
            vm0_variant: "a",
            gclid: "test-gclid",
            gclid_present: "true",
            recorded_at: RECORDED_AT_ISO,
          },
        },
      },
    );
  });

  it("retries the Clerk user read before writing attribution", async () => {
    mockNow(new Date(RECORDED_AT_ISO));
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.signalTimers.delay.mockResolvedValue(undefined);
    context.mocks.clerk.users.getUserList
      .mockRejectedValueOnce(new ClerkApiResponseTestError(2))
      .mockResolvedValue({
        data: [{ id: userId, privateMetadata: {} }],
      });
    context.mocks.clerk.users.updateUserMetadata.mockResolvedValue({});

    const response = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            vm0_source: "presentation",
          },
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ recorded: true });
    expect(context.mocks.clerk.users.getUserList).toHaveBeenCalledTimes(2);
    expect(context.mocks.signalTimers.delay).toHaveBeenCalledTimes(1);
    expect(context.mocks.clerk.users.updateUserMetadata).toHaveBeenCalledTimes(
      1,
    );
  });

  it("does not overwrite existing signup attribution", async () => {
    const userId = `user_${randomUUID()}`;
    mocks.clerk.session(userId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: userId,
          privateMetadata: {
            signup_attribution: {
              vm0_source: "existing",
            },
          },
        },
      ],
    });

    const response = await accept(
      client().recordSignup({
        headers: { authorization: "Bearer clerk-session" },
        body: {
          attribution: {
            vm0_source: "presentation",
          },
        },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ recorded: false });
    expect(context.mocks.clerk.users.updateUserMetadata).not.toHaveBeenCalled();
  });
});
