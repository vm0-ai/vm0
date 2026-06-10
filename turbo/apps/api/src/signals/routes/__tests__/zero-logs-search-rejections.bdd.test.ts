import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the run-log Axiom-search auth, capability and
// empty-agent-filter cases. A keyword search that returns matches needs seeded
// runs plus an Axiom mock (GAP-RUN-CREDITS); but an `agentId` filter that
// matches no run short-circuits to an empty result before Axiom is queried, so
// the empty path is reachable without seeding. The matched/context/runId/limit/
// cross-org variants stay in the kept legacy. See `api.bdd.md`
// (CHAIN-LOGS-SEARCH-REJECTIONS).
const context = testContext();

const NO_RUN_AGENT = "00000000-0000-4000-8000-000000000002";

describe("run-log search rejections (API-first BDD)", () => {
  it("session search rejects unauthenticated / org-less callers and empties an unmatched agent filter", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.logsSearch.searchLogs({ query: { keyword: "test" }, headers: {} }),
      [401],
    );

    // No active organization.
    api.actAsNoOrg();
    await accept(
      api.logsSearch.searchLogs({
        query: { keyword: "test" },
        headers: SESSION_AUTH,
      }),
      [401],
    );

    // An agentId with no runs short-circuits to empty without querying Axiom.
    api.actAsAdmin();
    const empty = await accept(
      api.logsSearch.searchLogs({
        query: { keyword: "test", agentId: NO_RUN_AGENT },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(empty.body.results).toStrictEqual([]);
    expect(empty.body.hasMore).toBeFalsy();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("zero search rejects unauthenticated and capability-less callers", async () => {
    const api = createBddApi(context);

    // Unauthenticated.
    await accept(
      api.zeroLogsSearch.searchLogs({
        query: { keyword: "test" },
        headers: {},
      }),
      [401],
    );

    // A zero token without agent-run:read is forbidden.
    const forbidden = await accept(
      api.zeroLogsSearch.searchLogs({
        query: { keyword: "test" },
        headers: api.zeroAuth([]),
      }),
      [403],
    );
    expect(forbidden.body.error.message).toContain("agent-run:read");
  });
});
