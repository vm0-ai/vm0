import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the daily insights + insights-range auth and
// empty-org cases. Populated insights (day shapes, totals, stale-entry
// filtering, days clamping, cross-org/user isolation) need seeded usage rows
// (GAP-USAGE-EVENTS) and stay in the kept legacy. See `api.bdd.md`
// (CHAIN-INSIGHTS-REJECTIONS).
const context = testContext();

describe("zero insights rejections (API-first BDD)", () => {
  it("insights rejects unauthenticated / org-less callers and is empty for a fresh org", async () => {
    const api = createBddApi(context);

    await accept(api.insights.get({ query: {}, headers: {} }), [401]);

    api.actAsNoOrg();
    await accept(api.insights.get({ query: {}, headers: SESSION_AUTH }), [401]);

    api.actAsAdmin();
    const empty = await accept(
      api.insights.get({ query: {}, headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body.days).toStrictEqual([]);
    expect(empty.body.totalCredits).toBe(0);
    expect(empty.body.totalRuns).toBe(0);
    expect(empty.body.lastUpdated).toBeNull();
  });

  it("insights range rejects unauthenticated / org-less callers and returns nulls for a fresh org", async () => {
    const api = createBddApi(context);

    await accept(api.insightsRange.get({ headers: {} }), [401]);

    api.actAsNoOrg();
    await accept(api.insightsRange.get({ headers: SESSION_AUTH }), [401]);

    api.actAsAdmin();
    const empty = await accept(
      api.insightsRange.get({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body.minDate).toBeNull();
    expect(empty.body.maxDate).toBeNull();
    expect(empty.body.totalDays).toBe(0);
  });
});
