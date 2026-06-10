import { randomUUID } from "node:crypto";

import { accept, testContext } from "../../../__tests__/test-helpers";
import { createBddApi, SESSION_AUTH } from "./helpers/api-bdd";

// API-first BDD coverage for the per-run usage endpoint when there is nothing to
// report. An org with no processed usage events returns an empty page, and the
// runId is validated up front. Populated per-run records need seeded runs +
// usage events with no API surface (GAP-USAGE-EVENTS) and stay in the kept
// legacy. See `api.bdd.md` (CHAIN-USAGE-RUNS-REJECTIONS).
const context = testContext();

function emptyPage() {
  return {
    runs: [],
    pagination: { page: 1, pageSize: 20, total: 0 },
  };
}

describe("usage runs default + rejections (API-first BDD)", () => {
  it("requires authentication and an admin caller", async () => {
    const api = createBddApi(context);

    const unauth = await accept(
      api.usageRuns.get({ query: {}, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    api.actAsMember({
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
    });
    const member = await accept(
      api.usageRuns.get({ query: {}, headers: SESSION_AUTH }),
      [403],
    );
    expect(member.body.error.message).toBe(
      "Only org admins can view run usage",
    );
  });

  it("returns an empty page when no runs have processed usage, and validates runId", async () => {
    const api = createBddApi(context);
    api.actAsAdmin();

    // No processed usage for the org.
    const empty = await accept(
      api.usageRuns.get({ query: {}, headers: SESSION_AUTH }),
      [200],
    );
    expect(empty.body).toStrictEqual(emptyPage());

    // A known run id with no processed usage is also an empty page.
    const emptyRun = await accept(
      api.usageRuns.get({
        query: { runId: randomUUID() },
        headers: SESSION_AUTH,
      }),
      [200],
    );
    expect(emptyRun.body).toStrictEqual(emptyPage());

    // A malformed runId is rejected.
    const badId = await accept(
      api.usageRuns.get({
        query: { runId: "not-a-uuid" },
        headers: SESSION_AUTH,
      }),
      [400],
    );
    expect(badId.body.error.code).toBe("BAD_REQUEST");
  });
});
