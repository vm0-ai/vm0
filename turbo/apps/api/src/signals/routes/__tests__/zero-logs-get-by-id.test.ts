import { randomUUID } from "node:crypto";

import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
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
  seedOrphanRun$,
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

function detailClient() {
  return setupApp({ context })(logsByIdContract);
}

// Bypass the ts-rest client's response-set validation for the 400-invalid-UUID
// case. The framework rejects the request via zod pathParams validation BEFORE
// the route handler runs; the contract response set (200/401/403/404) does not
// include 400. Same pattern as zero-logs-list.test.ts (PR #12469).
async function rawGetLog(id: string): Promise<{ status: number }> {
  const app = createApp({ signal: context.signal, routes: ROUTES });
  const response = await app.request(`/api/zero/logs/${id}`, {
    method: "GET",
    headers: { authorization: "Bearer clerk-session" },
  });
  return { status: response.status };
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("GET /api/zero/logs/:id", () => {
  const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
    return store.set(deleteUsageInsightFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const response = await accept(
      detailClient().getById({ headers: {}, params: { id: randomUUID() } }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no organization", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const response = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: randomUUID() },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 400 for an invalid UUID", async () => {
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const response = await rawGetLog("not-a-uuid");
    expect(response.status).toBe(400);
  });

  it("returns 404 for a non-existent run id", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: randomUUID() },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Log not found", code: "NOT_FOUND" },
    });
  });

  it("returns 404 when accessing another user's run", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const otherUserId = `user_${randomUUID()}`;
    const otherCompose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: otherUserId },
      context.signal,
    );
    const { runId: otherRunId } = await store.set(
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
      detailClient().getById({
        headers: authHeaders(),
        params: { id: otherRunId },
      }),
      [404],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Log not found", code: "NOT_FOUND" },
    });
  });

  it("returns run details for the authenticated owner", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const sessionId = `session_${randomUUID()}`;
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId,
        status: "completed",
        result: { agentSessionId: sessionId },
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: runId },
      }),
      [200],
    );
    expect(response.body.id).toBe(runId);
    expect(response.body.agentId).toBe(composeId);
    expect(response.body.framework).toBe("claude-code");
    expect(response.body.status).toBe("completed");
    expect(response.body.prompt).toBe("test prompt");
    expect(response.body.error).toBeNull();
    expect(response.body.sessionId).toBe(sessionId);
  });

  it("returns displayName from agent metadata", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId } = await store.set(
      seedCompose$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        displayName: "Agent Display Name",
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
      detailClient().getById({
        headers: authHeaders(),
        params: { id: runId },
      }),
      [200],
    );
    expect(response.body.id).toBe(runId);
    expect(response.body.displayName).toBe("Agent Display Name");
  });

  it("returns null displayName when agent metadata has none", async () => {
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
      detailClient().getById({
        headers: authHeaders(),
        params: { id: runId },
      }),
      [200],
    );
    expect(response.body.id).toBe(runId);
    expect(response.body.displayName).toBeNull();
  });

  it("returns a pending-status run with null sessionId and completedAt", async () => {
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
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: runId },
      }),
      [200],
    );
    expect(response.body.id).toBe(runId);
    expect(response.body.status).toBe("pending");
    expect(response.body.sessionId).toBeNull();
    expect(response.body.completedAt).toBeNull();
  });

  it("returns a failed run with the error message populated", async () => {
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
        status: "failed",
        error: "Sandbox creation failed",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: runId },
      }),
      [200],
    );
    expect(response.body.status).toBe("failed");
    expect(response.body.error).toBe("Sandbox creation failed");
  });

  it("returns scheduleId and triggerSource=schedule when a schedule is linked", async () => {
    const fixture = await track(
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
    const { runId } = await store.set(
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
      detailClient().getById({
        headers: authHeaders(),
        params: { id: runId },
      }),
      [200],
    );
    expect(response.body.id).toBe(runId);
    expect(response.body.scheduleId).toBe(scheduleId);
    expect(response.body.triggerSource).toBe("schedule");
  });

  it("returns null scheduleId for non-schedule runs", async () => {
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
      detailClient().getById({
        headers: authHeaders(),
        params: { id: runId },
      }),
      [200],
    );
    expect(response.body.scheduleId).toBeNull();
  });

  it("returns run details when the compose version has been deleted", async () => {
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { runId } = await store.set(
      seedOrphanRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        prompt: "Orphan run prompt",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const response = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: runId },
      }),
      [200],
    );
    expect(response.body.id).toBe(runId);
    expect(response.body.prompt).toBe("Orphan run prompt");
    expect(response.body.agentId).toBeNull();
    expect(response.body.framework).toBeNull();
  });

  describe("zero token auth", () => {
    const innerTrack = createFixtureTracker<OrgMembershipFixture>((fixture) => {
      return store.set(deleteOrgMembership$, fixture, context.signal);
    });

    it("returns 200 for a zero token with agent-run:read capability", async () => {
      const userId = `user_${randomUUID()}`;
      const orgId = `org_${randomUUID()}`;
      await innerTrack(
        store.set(
          seedOrgMembership$,
          { orgId, userId, role: "member" },
          context.signal,
        ),
      );
      // Track for usage-insight cleanup too (compose/run/zero_run rows)
      const usageFixture: UsageInsightFixture = { orgId, userId };
      await track(Promise.resolve(usageFixture));
      const { composeId } = await store.set(
        seedCompose$,
        { orgId, userId },
        context.signal,
      );
      const { runId } = await store.set(
        seedRun$,
        {
          orgId,
          userId,
          composeId,
          status: "completed",
          result: { agentSessionId: `session_${randomUUID()}` },
        },
        context.signal,
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
        detailClient().getById({
          headers: { authorization: `Bearer ${token}` },
          params: { id: runId },
        }),
        [200],
      );
      expect(response.body.id).toBe(runId);
    });

    it("returns 403 for a sandbox token without agent-run:read capability", async () => {
      const seconds = currentSecond();
      const token = signSandboxJwtForTests({
        scope: "zero",
        userId: `user_${randomUUID()}`,
        orgId: `org_${randomUUID()}`,
        runId: `run_${randomUUID()}`,
        capabilities: ["file:read"],
        iat: seconds,
        exp: seconds + 60,
      });

      const response = await accept(
        detailClient().getById({
          headers: { authorization: `Bearer ${token}` },
          params: { id: randomUUID() },
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
      const response = await accept(
        detailClient().getById({ headers: {}, params: { id: randomUUID() } }),
        [401],
      );
      expect(response.body).toStrictEqual({
        error: { message: "Not authenticated", code: "UNAUTHORIZED" },
      });
    });
  });
});
