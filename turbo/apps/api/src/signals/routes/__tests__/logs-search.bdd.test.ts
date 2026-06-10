import { randomUUID } from "node:crypto";

import { logsSearchContract } from "@vm0/api-contracts/contracts/runs";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { ROUTES } from "../../route";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";

// BDD migration of the legacy `logs-search.test.ts`. The 13
// legacy `it()`s collapse into 3 BDD `it()`s: (1) auth
// chain (401 no auth → 401 no-org), (2) success chain (200
// empty results → 200 matched without context → 200 matched
// with context → 200 filters by runId → 200 uses Axiom
// search operator → 200 filters by agentId via DB lookup →
// 200 empty for agentId with no runs → 200 sets hasMore
// when matches exceed limit → 200 scopes broad searches to
// authenticated org runs → 200 empty for runId from a
// different org), (3) 400 chain (400 missing keyword).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function logsClient() {
  return setupApp({ context })(logsSearchContract);
}

async function rawSearchLogs(
  query: string,
  authorization = "Bearer clerk-session",
): Promise<{ status: number; body: unknown }> {
  const app = createApp({ signal: context.signal, routes: ROUTES });
  const response = await app.request(`/api/logs/search${query}`, {
    method: "GET",
    headers: { authorization },
  });
  const text = await response.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  return { status: response.status, body };
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
}

function createLogsHarness(): {
  readonly setupSearchFixture: () => Promise<SearchFixture>;
} {
  const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  const setupSearchFixture = async (): Promise<SearchFixture> => {
    const fixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      fixture,
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      { ...fixture, composeId },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    return {
      orgId: fixture.orgId,
      userId: fixture.userId,
      composeId,
      runId,
    };
  };

  return { setupSearchFixture };
}

describe("BDD GET /api/logs/search — auth chain", () => {
  it("gwt-wt-wt: 401 no auth → 401 no-org", async () => {
    // When + Then: 401 — no auth header.
    const noAuth = await accept(
      logsClient().searchLogs({ query: { keyword: "test" }, headers: {} }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session with a user but no org.
    mocks.clerk.session(`user_${randomUUID()}`, null);

    // When + Then: still 401.
    const noOrg = await accept(
      logsClient().searchLogs({
        query: { keyword: "test" },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/logs/search — 200 success chain", () => {
  const { setupSearchFixture } = createLogsHarness();

  it("gwt-wt-wt: 200 empty results → 200 matched without context → 200 matched with context → 200 filters by runId → 200 uses Axiom search operator → 200 filters by agentId via DB lookup → 200 empty for agentId with no runs → 200 sets hasMore when matches exceed limit → 200 scopes broad searches to authenticated org runs → 200 empty for runId from a different org", async () => {
    // Given: a search fixture + an empty Axiom query result.
    await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([]);

    // When + Then: 200 — empty results.
    const empty = await accept(
      logsClient().searchLogs({
        query: { keyword: "nonexistent" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(empty.body.results).toStrictEqual([]);
    expect(empty.body.hasMore).toBeFalsy();

    // Given: a search fixture + a single matched event.
    const matched = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(matched.runId, 3, "OOM killed"),
    ]);

    // When + Then: 200 — matched events without context.
    const matchedResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "OOM" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(matchedResponse.body.results).toHaveLength(1);
    expect(matchedResponse.body.results[0]?.runId).toBe(matched.runId);
    expect(matchedResponse.body.results[0]?.matchedEvent.sequenceNumber).toBe(3);
    expect(matchedResponse.body.results[0]?.contextBefore).toStrictEqual([]);
    expect(matchedResponse.body.results[0]?.contextAfter).toStrictEqual([]);

    // Given: a search fixture + a matched event with
    // before/after context events.
    const contextFx = await setupSearchFixture();
    context.mocks.axiom.query
      .mockResolvedValueOnce([
        makeAxiomEvent(
          contextFx.runId,
          5,
          "Error: OOM killed",
          "2026-01-15T10:30:05Z",
        ),
      ])
      .mockResolvedValueOnce([
        makeAxiomEvent(
          contextFx.runId,
          4,
          "Building...",
          "2026-01-15T10:30:04Z",
        ),
        makeAxiomEvent(
          contextFx.runId,
          5,
          "Error: OOM killed",
          "2026-01-15T10:30:05Z",
        ),
        makeAxiomEvent(
          contextFx.runId,
          6,
          "Retrying...",
          "2026-01-15T10:30:06Z",
        ),
      ]);

    // When + Then: 200 — matched events with before/after
    // context.
    const contextResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "OOM", before: 1, after: 1 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(contextResponse.body.results).toHaveLength(1);
    expect(contextResponse.body.results[0]?.matchedEvent.sequenceNumber).toBe(5);
    expect(contextResponse.body.results[0]?.contextBefore).toHaveLength(1);
    expect(contextResponse.body.results[0]?.contextBefore[0]?.sequenceNumber).toBe(
      4,
    );
    expect(contextResponse.body.results[0]?.contextAfter).toHaveLength(1);
    expect(contextResponse.body.results[0]?.contextAfter[0]?.sequenceNumber).toBe(
      6,
    );

    // Given: a search fixture + a runId-scoped matched
    // event.
    const runIdFx = await setupSearchFixture();
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(runIdFx.runId, 1, "Found it"),
    ]);

    // When + Then: 200 — filters by runId; the APL query
    // contains the runId filter.
    const runIdResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "Found", runId: runIdFx.runId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(runIdResponse.body.results).toHaveLength(1);
    expect(runIdResponse.body.results[0]?.runId).toBe(runIdFx.runId);
    const runIdApl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(runIdApl).toContain(`runId == "${runIdFx.runId}"`);

    // Given: a search fixture + a keyword-only search.
    const keywordFx = await setupSearchFixture();
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(keywordFx.runId, 2, "deploy failed with error"),
    ]);

    // When + Then: 200 — the APL query uses the
    // `search` operator with the keyword.
    const keywordResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "deploy failed" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(keywordResponse.body.results).toHaveLength(1);
    expect(keywordResponse.body.results[0]?.matchedEvent.sequenceNumber).toBe(2);
    const keywordApl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(keywordApl).toContain('search "*deploy failed*"');

    // Given: a search fixture + an agentId-scoped matched
    // event.
    const agentFx = await setupSearchFixture();
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(agentFx.runId, 1, "Agent scoped event"),
    ]);

    // When + Then: 200 — filters by agentId via DB lookup;
    // the APL query contains the runId filter (resolved
    // from the agentId).
    const agentResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "event", agentId: agentFx.composeId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(agentResponse.body.results).toHaveLength(1);
    expect(agentResponse.body.results[0]?.runId).toBe(agentFx.runId);
    const agentApl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(agentApl).toContain(`runId == "${agentFx.runId}"`);

    // Given: a fresh search fixture.
    const emptyAgentFx = await setupSearchFixture();
    context.mocks.axiom.query.mockClear();

    // When + Then: 200 — empty results for an agentId with
    // no runs; Axiom query is not called.
    const emptyAgentResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "test", agentId: randomUUID() },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(emptyAgentResponse.body.results).toStrictEqual([]);
    expect(emptyAgentResponse.body.hasMore).toBeFalsy();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();

    // Given: a search fixture + 5 matched events.
    const hasMoreFx = await setupSearchFixture();
    const hasMoreEvents = Array.from({ length: 5 }, (_, index) => {
      return makeAxiomEvent(hasMoreFx.runId, index, `Match ${index}`);
    });
    context.mocks.axiom.query.mockResolvedValueOnce(hasMoreEvents);

    // When + Then: 200 — hasMore is true when matches
    // exceed the requested limit.
    const hasMoreResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "Match", limit: 2 },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(hasMoreResponse.body.results).toHaveLength(2);
    expect(hasMoreResponse.body.hasMore).toBeTruthy();

    // Given: two org fixtures + a Clerk session for `main`.
    const main = await setupSearchFixture();
    const other = await setupSearchFixture();
    mocks.clerk.session(main.userId, main.orgId);
    context.mocks.axiom.query.mockClear();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(main.runId, 1, "Default org event"),
    ]);

    // When + Then: 200 — broad searches are scoped to the
    // authenticated org's runs; the other org's runId is
    // not in the APL query.
    const scopedResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "event" },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(scopedResponse.body.results).toHaveLength(1);
    expect(scopedResponse.body.results[0]?.runId).toBe(main.runId);
    const scopedApl = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(scopedApl).toContain(main.runId);
    expect(scopedApl).not.toContain(other.runId);

    // Given: a session for `main` + a runId from a
    // different org.
    const otherRunIdFx = await setupSearchFixture();
    mocks.clerk.session(main.userId, main.orgId);
    context.mocks.axiom.query.mockClear();

    // When + Then: 200 — empty results; Axiom query is not
    // called for a runId from a different org.
    const otherRunIdResponse = await accept(
      logsClient().searchLogs({
        query: { keyword: "test", runId: otherRunIdFx.runId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(otherRunIdResponse.body.results).toStrictEqual([]);
    expect(otherRunIdResponse.body.hasMore).toBeFalsy();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });
});

describe("BDD GET /api/logs/search — 400 chain", () => {
  const { setupSearchFixture } = createLogsHarness();

  it("gwt-wt-wt: 400 missing keyword", async () => {
    // Given: a fresh search fixture.
    const fixture = await setupSearchFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 400 — missing keyword.
    const response = await rawSearchLogs("?limit=10");
    expect(response.status).toBe(400);
  });
});
