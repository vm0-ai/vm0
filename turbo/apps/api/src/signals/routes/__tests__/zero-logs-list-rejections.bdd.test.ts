import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the run-log list auth and empty-org cases. A list
// with rows needs funded runs that emit logs (GAP-RUN-CREDITS), and the
// out-of-range-limit / non-UUID-agentId validations return a 400 the contract
// does not declare (the ts-rest client throws on it), so those stay in the kept
// legacy alongside the cross-user isolation, cursor paging and
// agent-filter-with-rows variants. See `api.bdd.md` (CHAIN-LOGS-LIST-REJECTIONS).
const context = testContext();

describe("run-log list rejections (API-first BDD)", () => {
  it("rejects unauthenticated / org-less reads and returns an empty list for a fresh org", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(api.logsList.list({ headers: {} }), [401]);

    // No active organization.
    api.actAsNoOrg();
    await accept(api.logsList.list({ headers: SESSION_AUTH }), [401]);

    // A fresh org has no runs, so the list is empty.
    api.actAsAdmin();
    const empty = await accept(
      api.logsList.list({ headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body.data).toStrictEqual([]);
    expect(empty.body.pagination.hasMore).toBeFalsy();
    expect(empty.body.pagination.nextCursor).toBeNull();
  });
});
