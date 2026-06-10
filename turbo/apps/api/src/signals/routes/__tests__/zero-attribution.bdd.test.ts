import { randomUUID } from "node:crypto";

import { zeroAttributionContract } from "@vm0/api-contracts/contracts/zero-attribution";
import { expect, it } from "vitest";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { createZeroRouteMocks } from "./helpers/zero-route-test";
import { zeroAttributionRoutes } from "../zero-attribution";

// BDD migration of the legacy `zero-attribution.test.ts`. The Given is
// purely a Clerk session + a mocked `getUserList` response — no DB
// writes, only external service mocks. The 3 legacy `it()`s collapse
// into 2: a small auth-boundary test, and one gwt-wt-wt chain that
// shares the Clerk session.

const context = testContext();
const mocks = createZeroRouteMocks(context);

const RECORDED_AT_ISO = "2026-05-30T12:00:00.000Z";

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context, routes: zeroAttributionRoutes })(
    zeroAttributionContract,
  );
}

describe("BDD POST /api/zero/attribution/signup — auth boundary", () => {
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
});

describe("BDD POST /api/zero/attribution/signup — write & preserve chain", () => {
  it("gwt-wt-wt: first-touch write → existing attribution is preserved", async () => {
    // Given: a Clerk session with a user whose privateMetadata has no
    // prior signup_attribution.
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
    const c = client();

    // When + Then: the first signup call writes the first-touch
    // attribution under the existing privateMetadata, with the recorded
    // timestamp from the mocked clock.
    const first = await accept(
      c.recordSignup({
        headers: authHeaders(),
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
    expect(first.body).toStrictEqual({ recorded: true });
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

    // Given: a second user already has signup_attribution in their
    // privateMetadata (a returning session). The Clerk update mock is
    // reset so we can assert it is NOT called.
    const secondUserId = `user_${randomUUID()}`;
    mocks.clerk.session(secondUserId, null);
    context.mocks.clerk.users.getUserList.mockResolvedValue({
      data: [
        {
          id: secondUserId,
          privateMetadata: {
            signup_attribution: {
              vm0_source: "existing",
            },
          },
        },
      ],
    });
    context.mocks.clerk.users.updateUser.mockReset();
    context.mocks.clerk.users.updateUser.mockResolvedValue({});

    // When + Then: the response reports the call was NOT recorded, and
    // the update was skipped to preserve the first-touch value.
    const second = await accept(
      c.recordSignup({
        headers: authHeaders(),
        body: {
          attribution: {
            vm0_source: "presentation",
          },
        },
      }),
      [200],
    );
    expect(second.body).toStrictEqual({ recorded: false });
    expect(context.mocks.clerk.users.updateUser).not.toHaveBeenCalled();
  });
});
