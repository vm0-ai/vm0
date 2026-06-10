import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { mockNow } from "../../../lib/time";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for first-touch signup attribution. The attribution is
// stored in Clerk private metadata, which Clerk owns: the caller's existing
// metadata is the external precondition (mocked) and the merged write is
// verified through the Clerk update mock, while the idempotency outcome is read
// from the real response (`recorded`). See `api.bdd.md` (CHAIN-ATTRIBUTION).
const context = testContext();

const RECORDED_AT_ISO = "2026-05-30T12:00:00.000Z";

describe("signup attribution (API-first BDD)", () => {
  it("records first-touch attribution and merges it into Clerk metadata", async () => {
    const api = createBddApi(context);
    mockNow(new Date(RECORDED_AT_ISO));
    const userId = `user_${randomUUID()}`;
    api.actAsNoOrg(userId);
    api.mockClerkUserPrivateMetadata(userId, { existing: "value" });

    const response = await accept(
      api.attribution.recordSignup({
        headers: SESSION_AUTH,
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

    // Then the response reports the write and the merge preserves prior keys.
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

  it("does not overwrite an existing signup attribution", async () => {
    const api = createBddApi(context);
    const userId = `user_${randomUUID()}`;
    api.actAsNoOrg(userId);
    api.mockClerkUserPrivateMetadata(userId, {
      signup_attribution: { vm0_source: "existing" },
    });

    const response = await accept(
      api.attribution.recordSignup({
        headers: SESSION_AUTH,
        body: { attribution: { vm0_source: "presentation" } },
      }),
      [200],
    );

    // Then it reports no write and leaves Clerk metadata untouched.
    expect(response.body).toStrictEqual({ recorded: false });
    expect(context.mocks.clerk.users.updateUser).not.toHaveBeenCalled();
  });

  it("requires a Clerk session", async () => {
    const api = createBddApi(context);

    const response = await api.attribution.recordSignup({
      headers: {},
      body: { attribution: { vm0_source: "presentation" } },
    });

    expect(response.status).toBe(401);
  });
});
