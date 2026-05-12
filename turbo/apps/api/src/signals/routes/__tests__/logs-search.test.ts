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

describe("GET /api/logs/search", () => {
  const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  async function setupSearchFixture(): Promise<SearchFixture> {
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
  }

  it("returns 401 when no auth is provided", async () => {
    const response = await accept(
      logsClient().searchLogs({ query: { keyword: "test" }, headers: {} }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const response = await accept(
      logsClient().searchLogs({
        query: { keyword: "test" },
        headers: authHeaders(),
      }),
      [401],
    );

    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty results when no matches", async () => {
    await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([]);

    const response = await accept(
      logsClient().searchLogs({
        query: { keyword: "nonexistent" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.results).toStrictEqual([]);
    expect(response.body.hasMore).toBeFalsy();
  });

  it("returns matched events without context", async () => {
    const fixture = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(fixture.runId, 3, "OOM killed"),
    ]);

    const response = await accept(
      logsClient().searchLogs({
        query: { keyword: "OOM" },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.runId).toBe(fixture.runId);
    expect(response.body.results[0]?.matchedEvent.sequenceNumber).toBe(3);
    expect(response.body.results[0]?.contextBefore).toStrictEqual([]);
    expect(response.body.results[0]?.contextAfter).toStrictEqual([]);
  });

  it("returns matched events with context", async () => {
    const fixture = await setupSearchFixture();
    context.mocks.axiom.query
      .mockResolvedValueOnce([
        makeAxiomEvent(
          fixture.runId,
          5,
          "Error: OOM killed",
          "2026-01-15T10:30:05Z",
        ),
      ])
      .mockResolvedValueOnce([
        makeAxiomEvent(fixture.runId, 4, "Building...", "2026-01-15T10:30:04Z"),
        makeAxiomEvent(
          fixture.runId,
          5,
          "Error: OOM killed",
          "2026-01-15T10:30:05Z",
        ),
        makeAxiomEvent(fixture.runId, 6, "Retrying...", "2026-01-15T10:30:06Z"),
      ]);

    const response = await accept(
      logsClient().searchLogs({
        query: { keyword: "OOM", before: 1, after: 1 },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.matchedEvent.sequenceNumber).toBe(5);
    expect(response.body.results[0]?.contextBefore).toHaveLength(1);
    expect(response.body.results[0]?.contextBefore[0]?.sequenceNumber).toBe(4);
    expect(response.body.results[0]?.contextAfter).toHaveLength(1);
    expect(response.body.results[0]?.contextAfter[0]?.sequenceNumber).toBe(6);
  });

  it("filters by runId when provided", async () => {
    const fixture = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(fixture.runId, 1, "Found it"),
    ]);

    const response = await accept(
      logsClient().searchLogs({
        query: { keyword: "Found", runId: fixture.runId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.runId).toBe(fixture.runId);

    const aplQuery = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(aplQuery).toContain(`runId == "${fixture.runId}"`);
  });

  it("filters by agentId via database lookup", async () => {
    const fixture = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(fixture.runId, 1, "Agent scoped event"),
    ]);

    const response = await accept(
      logsClient().searchLogs({
        query: { keyword: "event", agentId: fixture.composeId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.runId).toBe(fixture.runId);

    const aplQuery = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(aplQuery).toContain(`runId == "${fixture.runId}"`);
  });

  it("returns empty when searching by runId from a different org", async () => {
    const main = await setupSearchFixture();
    const other = await setupSearchFixture();
    mocks.clerk.session(main.userId, main.orgId);

    const response = await accept(
      logsClient().searchLogs({
        query: { keyword: "test", runId: other.runId },
        headers: authHeaders(),
      }),
      [200],
    );

    expect(response.body.results).toStrictEqual([]);
    expect(response.body.hasMore).toBeFalsy();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("returns 400 for missing keyword", async () => {
    const fixture = await setupSearchFixture();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await rawSearchLogs("?limit=10");

    expect(response.status).toBe(400);
  });
});
