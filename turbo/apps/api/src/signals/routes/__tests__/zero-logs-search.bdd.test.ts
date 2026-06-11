import { randomUUID } from "node:crypto";

import { zeroLogsSearchContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteOrgMembership$,
  seedOrgMembership$,
  type OrgMembershipFixture,
} from "./helpers/zero-org-membership";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedRuns$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

// BDD migration of the legacy `zero-logs-search.test.ts`.
// The 14 legacy `it()`s collapse into 3 BDD `it()`s: (1)
// auth + capability + no-matches + chunked query chain
// (401 unauthenticated → 403 sandbox without
// `agent-run:read` → 200 empty results + hasMore false →
// 200 splits large run ID searches into bounded Axiom
// queries), (2) success content chain (200 matched events
// without context → 200 matched events with context →
// 200 filters by runId → 200 uses search operator in axiom
// query → 200 filters by agentId via database lookup →
// 200 empty results when agentId has no runs → 200 sets
// hasMore when results exceed limit), (3) cross-org
// isolation chain (200 does not return runs from a
// different org → 200 empty when searching by runId from a
// different org → 401 authenticated session has no
// organization).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

function zeroToken(userId: string, orgId: string): string {
  const seconds = currentSecond();
  return signSandboxJwtForTests({
    scope: "zero",
    userId,
    orgId,
    runId: `run_${randomUUID()}`,
    capabilities: ["agent-run:read"],
    iat: seconds,
    exp: seconds + 600,
  });
}

function makeAxiomEvent(
  runId: string,
  sequenceNumber: number,
  text: string,
  timestamp = "2026-01-15T10:30:00Z",
): Record<string, unknown> {
  return {
    _time: timestamp,
    runId,
    userId: "test-user",
    sequenceNumber,
    eventType: "assistant",
    eventData: {
      type: "assistant",
      message: { content: [{ type: "text", text }] },
    },
  };
}

interface SearchFixture {
  readonly orgId: string;
  readonly userId: string;
  readonly composeId: string;
  readonly runId: string;
  readonly token: string;
}

const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});
const trackOrg = createFixtureTracker<OrgMembershipFixture>((fixture) => {
  return store.set(deleteOrgMembership$, fixture, context.signal);
});

async function setupSearchFixture(): Promise<SearchFixture> {
  const fixture = await trackUsage(
    store.set(seedUsageInsightFixture$, undefined, context.signal),
  );
  const { composeId } = await store.set(seedCompose$, fixture, context.signal);
  const { runId } = await store.set(
    seedRun$,
    { ...fixture, composeId },
    context.signal,
  );
  await trackOrg(
    store.set(
      seedOrgMembership$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    ),
  );

  return {
    orgId: fixture.orgId,
    userId: fixture.userId,
    composeId,
    runId,
    token: zeroToken(fixture.userId, fixture.orgId),
  };
}

describe("BDD GET /api/zero/logs/search — auth + capability + no-matches + chunked query chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 403 sandbox without agent-run:read → 200 empty results + hasMore false → 200 splits large run ID searches into bounded Axiom queries", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "test" },
        headers: {},
      }),
      [401],
    );
    expect(noAuth.body.error.code).toBe("UNAUTHORIZED");

    // Given: a sandbox token WITHOUT `agent-run:read`.

    // When + Then: 403.
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      iat: seconds,
      exp: seconds + 600,
    });
    const sandboxResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "test" },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );
    expect(sandboxResponse.body.error.message).toContain("agent-run:read");

    // Given: a fixture + Axiom returns no events.

    // When + Then: 200 — empty results + hasMore false.
    const noMatchFixture = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([]);
    const noMatchResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "nonexistent" },
        headers: { authorization: `Bearer ${noMatchFixture.token}` },
      }),
      [200],
    );
    expect(noMatchResponse.body.results).toStrictEqual([]);
    expect(noMatchResponse.body.hasMore).toBeFalsy();

    // Given: a fixture with 501 runs + Axiom matches one
    // chunked run.

    // When + Then: 200 — query is split into 2 bounded
    // Axiom calls (≤500 runIds per call) + the matching
    // run is in the results.
    context.mocks.axiom.query.mockClear();
    const chunkedFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: chunkedComposeId } = await store.set(
      seedCompose$,
      chunkedFixture,
      context.signal,
    );
    const { runIds } = await store.set(
      seedRuns$,
      { ...chunkedFixture, composeId: chunkedComposeId, count: 501 },
      context.signal,
    );
    await trackOrg(
      store.set(
        seedOrgMembership$,
        { orgId: chunkedFixture.orgId, userId: chunkedFixture.userId },
        context.signal,
      ),
    );

    const matchedRunId = runIds[runIds.length - 1]!;
    context.mocks.axiom.query.mockImplementation((apl) => {
      if (typeof apl !== "string") {
        return Promise.resolve([]);
      }
      const events = apl.includes(matchedRunId)
        ? [makeAxiomEvent(matchedRunId, 7, "chunked match")]
        : [];
      return Promise.resolve(events);
    });

    const chunkedResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "chunked" },
        headers: {
          authorization: `Bearer ${zeroToken(chunkedFixture.userId, chunkedFixture.orgId)}`,
        },
      }),
      [200],
    );

    expect(chunkedResponse.body.results).toHaveLength(1);
    expect(chunkedResponse.body.results[0]?.runId).toBe(matchedRunId);
    expect(context.mocks.axiom.query).toHaveBeenCalledTimes(2);

    for (const call of context.mocks.axiom.query.mock.calls) {
      const apl = call[0];
      expect(typeof apl).toBe("string");
      if (typeof apl !== "string") {
        throw new Error("Expected Axiom query to be a string");
      }
      const runIdCount = apl.match(
        /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g,
      )?.length;
      expect(runIdCount ?? 0).toBeLessThanOrEqual(500);
    }
  });
});

describe("BDD GET /api/zero/logs/search — success content chain", () => {
  it("gwt-wt-wt: 200 matched events without context → 200 matched events with context → 200 filters by runId → 200 uses search operator in axiom query → 200 filters by agentId via database lookup → 200 empty results when agentId has no runs → 200 sets hasMore when results exceed limit", async () => {
    // Given: a fixture + Axiom returns a single matched
    // event.

    // When + Then: 200 — matched event without context
    // returns empty before/after arrays.
    const noContextFixture = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(noContextFixture.runId, 3, "OOM killed"),
    ]);
    const noContextResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "OOM" },
        headers: { authorization: `Bearer ${noContextFixture.token}` },
      }),
      [200],
    );
    expect(noContextResponse.body.results).toHaveLength(1);
    expect(noContextResponse.body.results[0]?.runId).toBe(
      noContextFixture.runId,
    );
    expect(noContextResponse.body.results[0]?.matchedEvent.sequenceNumber).toBe(
      3,
    );
    expect(noContextResponse.body.results[0]?.contextBefore).toStrictEqual([]);
    expect(noContextResponse.body.results[0]?.contextAfter).toStrictEqual([]);

    // Given: a fixture + Axiom returns match + context
    // calls (before=1, after=1).

    // When + Then: 200 — the matched event is enriched
    // with one before + one after event.
    const withContextFixture = await setupSearchFixture();
    context.mocks.axiom.query
      .mockResolvedValueOnce([
        makeAxiomEvent(
          withContextFixture.runId,
          5,
          "Error: OOM killed",
          "2026-01-15T10:30:05Z",
        ),
      ])
      .mockResolvedValueOnce([
        makeAxiomEvent(
          withContextFixture.runId,
          4,
          "Building...",
          "2026-01-15T10:30:04Z",
        ),
        makeAxiomEvent(
          withContextFixture.runId,
          5,
          "Error: OOM killed",
          "2026-01-15T10:30:05Z",
        ),
        makeAxiomEvent(
          withContextFixture.runId,
          6,
          "Retrying...",
          "2026-01-15T10:30:06Z",
        ),
      ]);
    const withContextResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "OOM", before: 1, after: 1 },
        headers: { authorization: `Bearer ${withContextFixture.token}` },
      }),
      [200],
    );
    expect(withContextResponse.body.results).toHaveLength(1);
    expect(
      withContextResponse.body.results[0]?.matchedEvent.sequenceNumber,
    ).toBe(5);
    expect(withContextResponse.body.results[0]?.contextBefore).toHaveLength(1);
    expect(
      withContextResponse.body.results[0]?.contextBefore[0]?.sequenceNumber,
    ).toBe(4);
    expect(withContextResponse.body.results[0]?.contextAfter).toHaveLength(1);
    expect(
      withContextResponse.body.results[0]?.contextAfter[0]?.sequenceNumber,
    ).toBe(6);

    // Given: a fixture + Axiom returns a match + the query
    // includes a `runId` filter.

    // When + Then: 200 — the axiom query includes the
    // runId filter.
    context.mocks.axiom.query.mockClear();
    const runIdFilterFixture = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(runIdFilterFixture.runId, 1, "Found it"),
    ]);
    const runIdFilterResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "Found", runId: runIdFilterFixture.runId },
        headers: { authorization: `Bearer ${runIdFilterFixture.token}` },
      }),
      [200],
    );
    expect(runIdFilterResponse.body.results).toHaveLength(1);
    expect(runIdFilterResponse.body.results[0]?.runId).toBe(
      runIdFilterFixture.runId,
    );
    const runIdAplQuery = context.mocks.axiom.query.mock
      .calls[0]?.[0] as string;
    expect(runIdAplQuery).toContain(`runId == "${runIdFilterFixture.runId}"`);

    // Given: a fixture + Axiom returns a match + the
    // keyword has multiple words.

    // When + Then: 200 — the axiom query uses the
    // `search` operator.
    context.mocks.axiom.query.mockClear();
    const searchOperatorFixture = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(
        searchOperatorFixture.runId,
        2,
        "deploy failed with error",
      ),
    ]);
    const searchOperatorResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "deploy failed" },
        headers: { authorization: `Bearer ${searchOperatorFixture.token}` },
      }),
      [200],
    );
    expect(searchOperatorResponse.body.results).toHaveLength(1);
    const searchAplQuery = context.mocks.axiom.query.mock
      .calls[0]?.[0] as string;
    expect(searchAplQuery).toContain('search "*deploy failed*"');

    // Given: a fixture + Axiom returns a match + the
    // query includes an `agentId` filter.

    // When + Then: 200 — the agentId is resolved via
    // database lookup.
    context.mocks.axiom.query.mockClear();
    const agentIdFixture = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(agentIdFixture.runId, 1, "Agent scoped event"),
    ]);
    const agentIdResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "event", agentId: agentIdFixture.composeId },
        headers: { authorization: `Bearer ${agentIdFixture.token}` },
      }),
      [200],
    );
    expect(agentIdResponse.body.results).toHaveLength(1);
    expect(agentIdResponse.body.results[0]?.runId).toBe(agentIdFixture.runId);
    const agentAplQuery = context.mocks.axiom.query.mock
      .calls[0]?.[0] as string;
    expect(agentAplQuery).toContain(`runId == "${agentIdFixture.runId}"`);

    // Given: a fixture + an `agentId` with no runs.

    // When + Then: 200 — empty results + Axiom is not
    // called.
    context.mocks.axiom.query.mockClear();
    const noRunsAgentFixture = await setupSearchFixture();
    const noRunsResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "test", agentId: randomUUID() },
        headers: { authorization: `Bearer ${noRunsAgentFixture.token}` },
      }),
      [200],
    );
    expect(noRunsResponse.body.results).toStrictEqual([]);
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();

    // Given: a fixture + Axiom returns 5 matches + a limit
    // of 2.

    // When + Then: 200 — 2 results are returned +
    // hasMore is true.
    const hasMoreFixture = await setupSearchFixture();
    const events = Array.from({ length: 5 }, (_, i) => {
      return makeAxiomEvent(hasMoreFixture.runId, i, `Match ${i}`);
    });
    context.mocks.axiom.query.mockResolvedValueOnce(events);
    const hasMoreResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "Match", limit: 2 },
        headers: { authorization: `Bearer ${hasMoreFixture.token}` },
      }),
      [200],
    );
    expect(hasMoreResponse.body.results).toHaveLength(2);
    expect(hasMoreResponse.body.hasMore).toBeTruthy();
  });
});

describe("BDD GET /api/zero/logs/search — cross-org isolation chain", () => {
  it("gwt-wt-wt: 200 does not return runs from a different org → 200 empty when searching by runId from a different org → 401 authenticated session has no organization", async () => {
    // Given: two fixtures (main + other).

    // When + Then: 200 — keyword search returns only the
    // main org's matches + the axiom query contains the
    // main runId but NOT the other runId.
    context.mocks.axiom.query.mockClear();
    const main = await setupSearchFixture();
    const other = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(main.runId, 1, "Default org event"),
    ]);
    const crossOrgResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "event" },
        headers: { authorization: `Bearer ${main.token}` },
      }),
      [200],
    );
    expect(crossOrgResponse.body.results).toHaveLength(1);
    expect(crossOrgResponse.body.results[0]?.runId).toBe(main.runId);
    const crossOrgAplQuery = context.mocks.axiom.query.mock
      .calls[0]?.[0] as string;
    expect(crossOrgAplQuery).toContain(main.runId);
    expect(crossOrgAplQuery).not.toContain(other.runId);

    // Given: two fixtures (main + other).

    // When + Then: 200 — searching by the other org's
    // runId returns empty + Axiom is not called.
    context.mocks.axiom.query.mockClear();
    const isolatedMain = await setupSearchFixture();
    const isolatedOther = await setupSearchFixture();
    const isolatedResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "test", runId: isolatedOther.runId },
        headers: { authorization: `Bearer ${isolatedMain.token}` },
      }),
      [200],
    );
    expect(isolatedResponse.body.results).toStrictEqual([]);
    expect(isolatedResponse.body.hasMore).toBeFalsy();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();

    // Given: a Clerk session with no organization.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrgResponse = await accept(
      setupApp({ context })(zeroLogsSearchContract).searchLogs({
        query: { keyword: "test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(noOrgResponse.body.error.code).toBe("UNAUTHORIZED");
  });
});
