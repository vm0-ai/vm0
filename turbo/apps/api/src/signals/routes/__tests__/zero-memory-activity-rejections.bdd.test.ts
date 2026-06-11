import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the daily memory-activity timeline auth and
// empty-timeline cases. Populated entries (most-recent-day ordering,
// pagination, item ordering, no-item omission, cross-user/org scoping) need
// seeded activity summaries (GAP-MEMORY-ACTIVITY-SEED) and stay in the kept
// legacy. See `api.bdd.md` (CHAIN-MEMORY-ACTIVITY-REJECTIONS).
const context = testContext();

describe("zero memory activity rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less callers and is empty for a fresh user", async () => {
    const api = createBddApi(context);

    await accept(api.memoryActivity.get({ query: {}, headers: {} }), [401]);

    api.actAsNoOrg();
    await accept(
      api.memoryActivity.get({ query: {}, headers: SESSION_AUTH }),
      [401],
    );

    // A fresh user has no memory-activity summaries.
    api.actAsAdmin();
    const empty = await accept(
      api.memoryActivity.get({ query: {}, headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body.entries).toStrictEqual([]);
    expect(empty.body.nextCursor).toBeNull();
  });
});
