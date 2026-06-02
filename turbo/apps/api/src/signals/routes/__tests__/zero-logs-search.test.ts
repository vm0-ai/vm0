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

describe("GET /api/zero/logs/search", () => {
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

  it("returns 401 when no auth is provided", async () => {
    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({ query: { keyword: "test" }, headers: {} }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });

  it("returns 403 for sandbox token without agent-run:read", async () => {
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "sandbox",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      iat: seconds,
      exp: seconds + 600,
    });

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "test" },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
      [403],
    );
    expect(response.body.error.message).toContain("agent-run:read");
  });

  it("returns empty results when no matches", async () => {
    const f = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([]);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "nonexistent" },
        headers: { authorization: `Bearer ${f.token}` },
      }),
      [200],
    );
    expect(response.body.results).toStrictEqual([]);
    expect(response.body.hasMore).toBeFalsy();
  });

  it("splits large run ID searches into bounded Axiom queries", async () => {
    const fixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      fixture,
      context.signal,
    );
    const { runIds } = await store.set(
      seedRuns$,
      { ...fixture, composeId, count: 501 },
      context.signal,
    );
    await trackOrg(
      store.set(
        seedOrgMembership$,
        { orgId: fixture.orgId, userId: fixture.userId },
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

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "chunked" },
        headers: {
          authorization: `Bearer ${zeroToken(fixture.userId, fixture.orgId)}`,
        },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.runId).toBe(matchedRunId);
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

  it("returns matched events without context", async () => {
    const f = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(f.runId, 3, "OOM killed"),
    ]);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "OOM" },
        headers: { authorization: `Bearer ${f.token}` },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.runId).toBe(f.runId);
    expect(response.body.results[0]?.matchedEvent.sequenceNumber).toBe(3);
    expect(response.body.results[0]?.contextBefore).toStrictEqual([]);
    expect(response.body.results[0]?.contextAfter).toStrictEqual([]);
  });

  it("returns matched events with context", async () => {
    const f = await setupSearchFixture();
    context.mocks.axiom.query
      .mockResolvedValueOnce([
        makeAxiomEvent(f.runId, 5, "Error: OOM killed", "2026-01-15T10:30:05Z"),
      ])
      .mockResolvedValueOnce([
        makeAxiomEvent(f.runId, 4, "Building...", "2026-01-15T10:30:04Z"),
        makeAxiomEvent(f.runId, 5, "Error: OOM killed", "2026-01-15T10:30:05Z"),
        makeAxiomEvent(f.runId, 6, "Retrying...", "2026-01-15T10:30:06Z"),
      ]);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "OOM", before: 1, after: 1 },
        headers: { authorization: `Bearer ${f.token}` },
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
    const f = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(f.runId, 1, "Found it"),
    ]);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "Found", runId: f.runId },
        headers: { authorization: `Bearer ${f.token}` },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.runId).toBe(f.runId);

    const aplQuery = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(aplQuery).toContain(`runId == "${f.runId}"`);
  });

  it("uses search operator in axiom query for keyword search", async () => {
    const f = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(f.runId, 2, "deploy failed with error"),
    ]);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "deploy failed" },
        headers: { authorization: `Bearer ${f.token}` },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    const aplQuery = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(aplQuery).toContain('search "*deploy failed*"');
  });

  it("filters by agentId via database lookup", async () => {
    const f = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(f.runId, 1, "Agent scoped event"),
    ]);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "event", agentId: f.composeId },
        headers: { authorization: `Bearer ${f.token}` },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.runId).toBe(f.runId);

    const aplQuery = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(aplQuery).toContain(`runId == "${f.runId}"`);
  });

  it("returns empty results when agentId has no runs", async () => {
    const f = await setupSearchFixture();

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "test", agentId: randomUUID() },
        headers: { authorization: `Bearer ${f.token}` },
      }),
      [200],
    );

    expect(response.body.results).toStrictEqual([]);
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("sets hasMore when results exceed limit", async () => {
    const f = await setupSearchFixture();
    const events = Array.from({ length: 5 }, (_, i) => {
      return makeAxiomEvent(f.runId, i, `Match ${i}`);
    });
    context.mocks.axiom.query.mockResolvedValueOnce(events);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "Match", limit: 2 },
        headers: { authorization: `Bearer ${f.token}` },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(2);
    expect(response.body.hasMore).toBeTruthy();
  });

  it("does not return runs from a different org", async () => {
    const main = await setupSearchFixture();
    const other = await setupSearchFixture();
    context.mocks.axiom.query.mockResolvedValueOnce([
      makeAxiomEvent(main.runId, 1, "Default org event"),
    ]);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "event" },
        headers: { authorization: `Bearer ${main.token}` },
      }),
      [200],
    );

    expect(response.body.results).toHaveLength(1);
    expect(response.body.results[0]?.runId).toBe(main.runId);

    const aplQuery = context.mocks.axiom.query.mock.calls[0]?.[0] as string;
    expect(aplQuery).toContain(main.runId);
    expect(aplQuery).not.toContain(other.runId);
  });

  it("returns empty when searching by runId from a different org", async () => {
    const main = await setupSearchFixture();
    const other = await setupSearchFixture();

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "test", runId: other.runId },
        headers: { authorization: `Bearer ${main.token}` },
      }),
      [200],
    );

    expect(response.body.results).toStrictEqual([]);
    expect(response.body.hasMore).toBeFalsy();
    expect(context.mocks.axiom.query).not.toHaveBeenCalled();
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);

    const client = setupApp({ context })(zeroLogsSearchContract);
    const response = await accept(
      client.searchLogs({
        query: { keyword: "test" },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body.error.code).toBe("UNAUTHORIZED");
  });
});
