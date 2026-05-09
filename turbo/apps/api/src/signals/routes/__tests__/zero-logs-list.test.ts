import { randomUUID } from "node:crypto";

import { logsListContract } from "@vm0/api-contracts/contracts/logs";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../external/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import { ROUTES } from "../../route";
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
  seedSchedule$,
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
  return setupApp({ context })(logsListContract);
}

// Raw fetch bypasses ts-rest client's response-set validation. Used for the
// 400 cases where the api framework rejects the request via zod query
// validation BEFORE the route handler runs — and the contract's response set
// (200/401/403) does not include 400.
async function rawListLogs(
  query: string,
  authorization = "Bearer clerk-session",
): Promise<{ status: number; body: unknown }> {
  const app = createApp({ signal: context.signal, routes: ROUTES });
  const response = await app.request(`/api/zero/logs${query}`, {
    method: "GET",
    headers: { authorization },
  });
  const text = await response.text();
  const body: unknown = text.length > 0 ? JSON.parse(text) : undefined;
  return { status: response.status, body };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/logs", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(logsClient().list({ headers: {} }), [401]);
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      logsClient().list({ headers: authHeaders() }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns empty list when user has no runs", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      logsClient().list({ headers: authHeaders() }),
      [200],
    );

    expect(response.body.data).toStrictEqual([]);
    expect(response.body.pagination.hasMore).toBeFalsy();
    expect(response.body.pagination.nextCursor).toBeNull();
  });

  it("returns runs filtered by current user only (cross-user isolation)", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const myCompose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId: myRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: myCompose.composeId,
        status: "completed",
      },
      context.signal,
    );

    const otherUserId = `user_${randomUUID()}`;
    const otherCompose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: otherUserId },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: otherUserId,
        composeId: otherCompose.composeId,
        status: "completed",
      },
      context.signal,
    );

    mocks.clerk.session(fixture.userId, fixture.orgId);
    const response = await accept(
      logsClient().list({ headers: authHeaders() }),
      [200],
    );

    const ids = response.body.data.map((r) => {
      return r.id;
    });
    expect(ids).toContain(myRunId);
    expect(ids).toHaveLength(1);
  });

  it("returns displayName from zero_agents metadata", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "My Display Name",
      },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      logsClient().list({ headers: authHeaders() }),
      [200],
    );

    const run = response.body.data.find((r) => {
      return r.id === runId;
    });
    expect(run?.displayName).toBe("My Display Name");
  });

  it("returns null displayName when zero_agents has none", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      logsClient().list({ headers: authHeaders() }),
      [200],
    );

    const run = response.body.data.find((r) => {
      return r.id === runId;
    });
    expect(run?.displayName).toBeNull();
  });

  it("returns 400 for invalid limit", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const response = await rawListLogs("?limit=0");
    expect(response.status).toBe(400);
  });

  it("returns 400 for limit exceeding maximum", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const response = await rawListLogs("?limit=101");
    expect(response.status).toBe(400);
  });

  describe("with runs", () => {
    const innerTrack = createFixtureTracker<UsageInsightFixture>((fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });

    async function setupThreeRuns(): Promise<{
      fixture: UsageInsightFixture;
      composeId: string;
      runIds: string[];
    }> {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const { composeId } = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      const runIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        const { runId } = await store.set(
          seedRun$,
          {
            orgId: fixture.orgId,
            userId: fixture.userId,
            composeId,
            status: "completed",
          },
          context.signal,
        );
        runIds.push(runId);
      }
      return { fixture, composeId, runIds };
    }

    it("returns list of runs ordered by createdAt DESC", async () => {
      const { fixture, runIds } = await setupThreeRuns();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );

      expect(response.body.data).toHaveLength(3);
      const returnedIds = response.body.data.map((r) => {
        return r.id;
      });
      for (const runId of runIds) {
        expect(returnedIds).toContain(runId);
      }
    });

    it("paginates correctly with limit and cursor across pages", async () => {
      const { fixture } = await setupThreeRuns();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const page1 = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { limit: 2 },
        }),
        [200],
      );
      expect(page1.body.data).toHaveLength(2);
      expect(page1.body.pagination.hasMore).toBeTruthy();
      expect(page1.body.pagination.nextCursor).not.toBeNull();

      const cursor = page1.body.pagination.nextCursor;
      if (cursor === null) {
        throw new Error("expected nextCursor");
      }
      const page2 = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { limit: 2, cursor },
        }),
        [200],
      );
      expect(page2.body.data).toHaveLength(1);
      expect(page2.body.pagination.hasMore).toBeFalsy();
      expect(page2.body.pagination.nextCursor).toBeNull();

      const allIds = [
        ...page1.body.data.map((r) => {
          return r.id;
        }),
        ...page2.body.data.map((r) => {
          return r.id;
        }),
      ];
      expect(new Set(allIds).size).toBe(allIds.length);
    });
  });

  describe("search functionality", () => {
    const innerTrack = createFixtureTracker<UsageInsightFixture>((fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });

    async function setupAlphaBeta(): Promise<{
      fixture: UsageInsightFixture;
    }> {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const alpha = await store.set(
        seedCompose$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: `search-alpha-${randomUUID().slice(0, 8)}`,
        },
        context.signal,
      );
      const beta = await store.set(
        seedCompose$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          name: `search-beta-${randomUUID().slice(0, 8)}`,
        },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: alpha.composeId,
          status: "completed",
        },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: beta.composeId,
          status: "completed",
        },
        context.signal,
      );
      return { fixture };
    }

    it("filters by agent name with fuzzy search", async () => {
      const { fixture } = await setupAlphaBeta();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { search: "alpha" },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
    });

    it("returns empty list when search has no matches", async () => {
      const { fixture } = await setupAlphaBeta();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { search: "nonexistent-agent-xyz" },
        }),
        [200],
      );
      expect(response.body.data).toStrictEqual([]);
      expect(response.body.pagination.hasMore).toBeFalsy();
    });

    it("matches case-insensitively for search", async () => {
      const { fixture } = await setupAlphaBeta();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { search: "ALPHA" },
        }),
        [200],
      );
      expect(response.body.data.length).toBeGreaterThan(0);
    });
  });

  describe("agent filter", () => {
    const innerTrack = createFixtureTracker<UsageInsightFixture>((fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });

    async function setupAlphaBetaAgents(): Promise<{
      fixture: UsageInsightFixture;
      alphaName: string;
      alphaComposeId: string;
      betaComposeId: string;
    }> {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const alphaName = `agent-alpha-${randomUUID().slice(0, 8)}`;
      const betaName = `agent-beta-${randomUUID().slice(0, 8)}`;
      const alpha = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId, name: alphaName },
        context.signal,
      );
      const beta = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId, name: betaName },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: alpha.composeId,
          status: "completed",
        },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: beta.composeId,
          status: "completed",
        },
        context.signal,
      );
      return {
        fixture,
        alphaName,
        alphaComposeId: alpha.composeId,
        betaComposeId: beta.composeId,
      };
    }

    it("filters by exact agentId", async () => {
      const { fixture, alphaComposeId } = await setupAlphaBetaAgents();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { agentId: alphaComposeId },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]?.agentId).toBe(alphaComposeId);
    });

    it("returns empty list when agent has no runs", async () => {
      const { fixture } = await setupAlphaBetaAgents();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { agentId: randomUUID() },
        }),
        [200],
      );
      expect(response.body.data).toStrictEqual([]);
    });

    it("returns 400 when agentId is not a UUID", async () => {
      const { fixture, alphaName } = await setupAlphaBetaAgents();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await rawListLogs(
        `?agentId=${encodeURIComponent(alphaName)}`,
      );
      expect(response.status).toBe(400);
    });

    it("agentId takes precedence over search param", async () => {
      const { fixture, alphaComposeId } = await setupAlphaBetaAgents();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { agentId: alphaComposeId, search: "beta" },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]?.agentId).toBe(alphaComposeId);
    });
  });

  describe("name filter", () => {
    const innerTrack = createFixtureTracker<UsageInsightFixture>((fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });

    async function setupNamedAgent(): Promise<{
      fixture: UsageInsightFixture;
      agentName: string;
      composeId: string;
    }> {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const agentName = `org-agent-${randomUUID().slice(0, 8)}`;
      const compose = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId, name: agentName },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: compose.composeId,
          status: "completed",
        },
        context.signal,
      );
      return { fixture, agentName, composeId: compose.composeId };
    }

    it("filters by name param", async () => {
      const { fixture, agentName, composeId } = await setupNamedAgent();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { name: agentName },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]?.agentId).toBe(composeId);
    });

    it("agentId takes precedence over name param", async () => {
      const { fixture, composeId } = await setupNamedAgent();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { name: "nonexistent", agentId: composeId },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]?.agentId).toBe(composeId);
    });
  });

  describe("trigger source inference", () => {
    const innerTrack = createFixtureTracker<UsageInsightFixture>((fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });

    async function setupComposeForSource(): Promise<{
      fixture: UsageInsightFixture;
      composeId: string;
    }> {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const compose = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      return { fixture, composeId: compose.composeId };
    }

    it("returns explicit trigger source when set on the run", async () => {
      const { fixture, composeId } = await setupComposeForSource();
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
          triggerSource: "slack",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      const run = response.body.data.find((r) => {
        return r.triggerSource === "slack";
      });
      expect(run).toBeDefined();
      expect(run?.triggerSource).toBe("slack");
    });

    it("returns 'schedule' for runs with triggerSource=schedule and a schedule linked", async () => {
      const { fixture, composeId } = await setupComposeForSource();
      const scheduleId = await store.set(
        seedSchedule$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          agentId: composeId,
          name: `sched-${randomUUID().slice(0, 8)}`,
        },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
          triggerSource: "schedule",
          scheduleId,
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      const run = response.body.data.find((r) => {
        return r.triggerSource === "schedule";
      });
      expect(run).toBeDefined();
      expect(run?.scheduleId).toBe(scheduleId);
    });

    it("returns null scheduleId for non-schedule runs", async () => {
      const { fixture, composeId } = await setupComposeForSource();
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
          triggerSource: "web",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      const run = response.body.data.find((r) => {
        return r.triggerSource === "web";
      });
      expect(run).toBeDefined();
      expect(run?.scheduleId).toBeNull();
    });

    it("returns 'web' for runs with triggerSource=web", async () => {
      const { fixture, composeId } = await setupComposeForSource();
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
          triggerSource: "web",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      const run = response.body.data.find((r) => {
        return r.triggerSource === "web";
      });
      expect(run).toBeDefined();
      expect(run?.triggerSource).toBe("web");
    });

    it("defaults to 'cli' when triggerSource is not set on the run", async () => {
      const { fixture, composeId } = await setupComposeForSource();
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(response.body.data.length).toBeGreaterThan(0);
      expect(response.body.data[0]?.triggerSource).toBe("cli");
    });
  });

  describe("triggerSource filter", () => {
    const innerTrack = createFixtureTracker<UsageInsightFixture>((fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });

    async function setupFourSourceRuns(): Promise<{
      fixture: UsageInsightFixture;
      composeId: string;
    }> {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const { composeId } = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      for (const source of ["web", "cli", "slack", "schedule"] as const) {
        await store.set(
          seedRun$,
          {
            orgId: fixture.orgId,
            userId: fixture.userId,
            composeId,
            status: "completed",
            triggerSource: source,
          },
          context.signal,
        );
      }
      return { fixture, composeId };
    }

    it("filters runs by triggerSource", async () => {
      const { fixture } = await setupFourSourceRuns();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { triggerSource: "slack" },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]?.triggerSource).toBe("slack");
    });

    it("returns all runs when triggerSource is omitted", async () => {
      const { fixture } = await setupFourSourceRuns();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(response.body.data).toHaveLength(4);
    });

    it("returns empty list when no runs match the triggerSource", async () => {
      const { fixture } = await setupFourSourceRuns();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { triggerSource: "github" },
        }),
        [200],
      );
      expect(response.body.data).toStrictEqual([]);
    });

    it("combines triggerSource with status filter", async () => {
      const { fixture, composeId } = await setupFourSourceRuns();
      // Add a failed web run alongside the existing completed web run
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "failed",
          triggerSource: "web",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { triggerSource: "web", status: "completed" },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]?.triggerSource).toBe("web");
      expect(response.body.data[0]?.status).toBe("completed");
    });

    it("combines triggerSource with agent filter", async () => {
      const { fixture } = await setupFourSourceRuns();
      const otherCompose = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: otherCompose.composeId,
          status: "completed",
          triggerSource: "slack",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: {
            triggerSource: "slack",
            agentId: otherCompose.composeId,
          },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.data[0]?.agentId).toBe(otherCompose.composeId);
      expect(response.body.data[0]?.triggerSource).toBe("slack");
    });

    it("counts total pages with triggerSource filter", async () => {
      const { fixture } = await setupFourSourceRuns();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { triggerSource: "web", limit: 1 },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination.totalPages).toBe(1);
    });
  });

  describe("filters response", () => {
    const innerTrack = createFixtureTracker<UsageInsightFixture>((fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });

    it("returns empty filters when user has no runs", async () => {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(response.body.filters).toStrictEqual({
        statuses: [],
        sources: [],
        agents: [],
      });
    });

    it("returns available statuses from user's runs", async () => {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const { composeId } = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
        },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "failed",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(response.body.filters.statuses).toContain("completed");
      expect(response.body.filters.statuses).toContain("failed");
    });

    it("returns available trigger sources from user's runs", async () => {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const { composeId } = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
          triggerSource: "slack",
        },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
          triggerSource: "web",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(response.body.filters.sources).toContain("slack");
      expect(response.body.filters.sources).toContain("web");
    });

    it("returns available agent IDs from user's runs", async () => {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const composeA = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      const composeB = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: composeA.composeId,
          status: "completed",
        },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId: composeB.composeId,
          status: "completed",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      expect(response.body.filters.agents).toContain(composeA.composeId);
      expect(response.body.filters.agents).toContain(composeB.composeId);
    });

    it("excludes null trigger sources from filters", async () => {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const { composeId } = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      // zero_runs.triggerSource is NOT NULL at the schema level, so a real
      // null can never appear in DB. The api's getAvailableFilters drops any
      // value not in the TriggerSource enum (which excludes null), so this
      // test pins the enum-based filter independent of how the value got there.
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({ headers: authHeaders() }),
        [200],
      );
      for (const source of response.body.filters.sources) {
        expect(source).not.toBeNull();
      }
    });

    it("returns filters independent of current query filters", async () => {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const { composeId } = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
          triggerSource: "slack",
        },
        context.signal,
      );
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "failed",
          triggerSource: "web",
        },
        context.signal,
      );
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { triggerSource: "slack" },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.filters.sources).toContain("slack");
      expect(response.body.filters.sources).toContain("web");
      expect(response.body.filters.statuses).toContain("completed");
      expect(response.body.filters.statuses).toContain("failed");
    });
  });

  describe("scheduleId filter", () => {
    const innerTrack = createFixtureTracker<UsageInsightFixture>((fixture) => {
      return store.set(deleteUsageInsightFixture$, fixture, context.signal);
    });

    async function setupScheduledRun(): Promise<{
      fixture: UsageInsightFixture;
      composeId: string;
      scheduleId: string;
    }> {
      const fixture = await innerTrack(
        store.set(seedUsageInsightFixture$, undefined, context.signal),
      );
      const { composeId } = await store.set(
        seedCompose$,
        { orgId: fixture.orgId, userId: fixture.userId },
        context.signal,
      );
      const scheduleId = await store.set(
        seedSchedule$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          agentId: composeId,
          name: `sched-${randomUUID().slice(0, 8)}`,
        },
        context.signal,
      );
      // Run linked to schedule
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
          scheduleId,
        },
        context.signal,
      );
      // Run NOT linked to any schedule
      await store.set(
        seedRun$,
        {
          orgId: fixture.orgId,
          userId: fixture.userId,
          composeId,
          status: "completed",
        },
        context.signal,
      );
      return { fixture, composeId, scheduleId };
    }

    it("returns only runs for the given scheduleId", async () => {
      const { fixture, scheduleId } = await setupScheduledRun();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { scheduleId },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
    });

    it("returns empty list when scheduleId has no matching runs", async () => {
      const { fixture } = await setupScheduledRun();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { scheduleId: randomUUID() },
        }),
        [200],
      );
      expect(response.body.data).toStrictEqual([]);
    });

    it("counts total pages with scheduleId filter", async () => {
      const { fixture, scheduleId } = await setupScheduledRun();
      mocks.clerk.session(fixture.userId, fixture.orgId);

      const response = await accept(
        logsClient().list({
          headers: authHeaders(),
          query: { scheduleId, limit: 1 },
        }),
        [200],
      );
      expect(response.body.data).toHaveLength(1);
      expect(response.body.pagination.totalPages).toBe(1);
    });

    it("returns 400 when scheduleId is not a UUID", async () => {
      mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
      const response = await rawListLogs("?scheduleId=not-a-uuid");
      expect(response.status).toBe(400);
    });
  });

  describe("zero token auth", () => {
    const innerTrack = createFixtureTracker<OrgMembershipFixture>((fixture) => {
      return store.set(deleteOrgMembership$, fixture, context.signal);
    });

    it("returns 200 for zero token with agent-run:read capability", async () => {
      const userId = `user_${randomUUID()}`;
      const orgId = `org_${randomUUID()}`;
      await innerTrack(
        store.set(
          seedOrgMembership$,
          { orgId, userId, role: "member" },
          context.signal,
        ),
      );
      const seconds = currentSecond();
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId,
        orgId,
        runId: `run_${randomUUID()}`,
        capabilities: ["agent-run:read"],
        iat: seconds,
        exp: seconds + 60,
      });

      const response = await accept(
        logsClient().list({
          headers: { authorization: `Bearer ${token}` },
        }),
        [200],
      );
      expect(response.body.data).toStrictEqual([]);
    });

    it("returns 403 for sandbox token without agent-run:read capability", async () => {
      const userId = `user_${randomUUID()}`;
      const orgId = `org_${randomUUID()}`;
      const seconds = currentSecond();
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId,
        orgId,
        runId: `run_${randomUUID()}`,
        capabilities: ["file:read"],
        iat: seconds,
        exp: seconds + 60,
      });

      const response = await accept(
        logsClient().list({
          headers: { authorization: `Bearer ${token}` },
        }),
        [403],
      );
      expect(response.body).toStrictEqual({
        error: {
          message: "Missing required capability: agent-run:read",
          code: "FORBIDDEN",
        },
      });
    });

    it("returns 401 when no auth is provided", async () => {
      const response = await accept(logsClient().list({ headers: {} }), [401]);
      expect(response.body).toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });
  });
});
