import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the usage members + insight auth, validation and
// empty-org cases. Aggregated member totals and non-empty insight buckets need
// seeded usage rows / usage_event records (GAP-RUN-CREDITS / GAP-USAGE-EVENTS)
// and stay in the kept legacy. See `api.bdd.md`
// (CHAIN-USAGE-MEMBERS-INSIGHT-REJECTIONS).
const context = testContext();

describe("usage members + insight rejections (API-first BDD)", () => {
  it("members rejects unauthenticated callers and returns an empty free-tier result", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.usageMembers.get({ headers: {} }), [401]);

    // A fresh org is free tier with no billing period, so the result is empty.
    api.actAsAdmin();
    const empty = await accept(
      api.usageMembers.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual({ period: null, members: [] });
  });

  it("insight rejects unauthenticated / org-less callers and validates timezone + range", async () => {
    const api = createBddApi(context);
    const base = { range: "7d", groupBy: "source", tz: "UTC" } as const;

    // Unauthenticated.
    await accept(api.usageInsight.get({ query: base, headers: {} }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.usageInsight.get({ query: base, headers: SESSION_AUTH }),
      [401],
    );

    // Invalid timezone is rejected.
    api.actAsAdmin();
    const badTz = await accept(
      api.usageInsight.get({
        query: { range: "7d", groupBy: "source", tz: "Not/A/Timezone" },
        headers: SESSION_AUTH,
      }),
      [400],
    );
    expect(badTz.body.error.code).toBe("BAD_REQUEST");

    // range=day requires an explicit date.
    const missingDate = await accept(
      api.usageInsight.get({
        query: { range: "day", groupBy: "source", tz: "UTC" },
        headers: SESSION_AUTH,
      }),
      [400],
    );
    expect(missingDate.body.error.code).toBe("BAD_REQUEST");

    // A valid timezone alias on a fresh org returns empty buckets.
    const empty = await accept(
      api.usageInsight.get({
        query: { range: "7d", groupBy: "source", tz: "US/Pacific" },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(Array.isArray(empty.body.buckets)).toBeTruthy();
  });
});
