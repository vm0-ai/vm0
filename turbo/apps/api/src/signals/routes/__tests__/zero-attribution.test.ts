import { randomUUID } from "node:crypto";

import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";
import { describe, expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroAttributionRoutes } from "../zero-attribution";

const context = testContext();
const mocks = createZeroRouteMocks(context);

const RECORDED_AT_ISO = "2026-05-30T12:00:00.000Z";

function client() {
  return setupApp({ context, routes: zeroAttributionRoutes })(
    zeroAttributionContract,
  );
}

describe("POST /api/zero/attribution/signup", () => {
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
    context.mocks.clerk.users.updateUser.mockResolvedValue({});

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
    expect(context.mocks.clerk.users.updateUser).toHaveBeenCalledWith(userId, {
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
    });
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
    expect(context.mocks.clerk.users.updateUser).not.toHaveBeenCalled();
  });
});
