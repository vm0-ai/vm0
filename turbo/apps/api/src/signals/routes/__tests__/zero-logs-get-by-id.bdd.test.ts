import { randomUUID } from "node:crypto";

import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
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

// BDD migration of the legacy `zero-logs-get-by-id.test.ts`.
// The 16 legacy `it()`s collapse into 3 BDD `it()`s:
// (1) auth + not-found + cross-user chain (401
// unauthenticated → 401 no org → 400 invalid UUID → 404
// non-existent → 404 another user's run),
// (2) success content chain (200 owner details → 200
// displayName from agent metadata → 200 null displayName
// when missing → 200 pending status with null fields →
// 200 failed run with error → 200 scheduleId +
// triggerSource=schedule when linked → 200 null scheduleId
// for non-schedule runs → 200 orphan run with null
// agentId/framework),
// (3) zero-token capability chain (200 with
// agent-run:read capability → 403 without capability →
// 401 no auth).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders() {
  return { authorization: "Bearer clerk-session" };
}

function detailClient() {
  return setupApp({ context })(logsByIdContract);
}

// Bypass the ts-rest client's response-set validation for
// the 400-invalid-UUID case. The framework rejects the
// request via zod pathParams validation BEFORE the route
// handler runs; the contract response set (200/401/403/
// 404) does not include 400. Same pattern as
// zero-logs-list.test.ts (PR #12469).
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

const trackUsage = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});
const trackOrg = createFixtureTracker<OrgMembershipFixture>((fixture) => {
  return store.set(deleteOrgMembership$, fixture, context.signal);
});

describe("BDD GET /api/zero/logs/:id — auth + not-found + cross-user chain", () => {
  it("gwt-wt-wt: 401 unauthenticated → 401 no org → 400 invalid UUID → 404 non-existent → 404 another user's run", async () => {
    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      detailClient().getById({ headers: {}, params: { id: randomUUID() } }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session with no org.

    // When + Then: 401.
    mocks.clerk.session(`user_${randomUUID()}`, null);
    const noOrg = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: randomUUID() },
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a Clerk session for a fresh user/org.

    // When + Then: 400 — the id is not a valid UUID.
    mocks.clerk.session(`user_${randomUUID()}`, `org_${randomUUID()}`);
    const invalidUuid = await rawGetLog("not-a-uuid");
    expect(invalidUuid.status).toBe(400);

    // Given: a Clerk session for a fixture with no
    // runs.

    // When + Then: 404 — log not found.
    const notFoundFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(notFoundFixture.userId, notFoundFixture.orgId);
    const notFoundResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: randomUUID() },
      }),
      [404],
    );
    expect(notFoundResponse.body).toStrictEqual({
      error: { message: "Log not found", code: "NOT_FOUND" },
    });

    // Given: a fixture with a run seeded by a different
    // user in the same org + a session for the current
    // user.

    // When + Then: 404 — cross-user isolation hides
    // another user's run.
    const crossUserFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const otherUserId = `user_${randomUUID()}`;
    const otherCompose = await store.set(
      seedCompose$,
      { orgId: crossUserFixture.orgId, userId: otherUserId },
      context.signal,
    );
    const { runId: otherRunId } = await store.set(
      seedRun$,
      {
        orgId: crossUserFixture.orgId,
        userId: otherUserId,
        composeId: otherCompose.composeId,
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(crossUserFixture.userId, crossUserFixture.orgId);
    const crossUserResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: otherRunId },
      }),
      [404],
    );
    expect(crossUserResponse.body).toStrictEqual({
      error: { message: "Log not found", code: "NOT_FOUND" },
    });
  });
});

describe("BDD GET /api/zero/logs/:id — success content chain", () => {
  it("gwt-wt-wt: 200 owner details → 200 displayName from agent metadata → 200 null displayName when missing → 200 pending status with null fields → 200 failed run with error → 200 scheduleId + triggerSource=schedule when linked → 200 null scheduleId for non-schedule runs → 200 orphan run with null agentId/framework", async () => {
    // Given: a fixture + a compose + a completed run
    // with a session + a session for the owner.

    // When + Then: 200 — id, agentId, framework, status,
    // prompt, error, and sessionId are populated.
    const ownerFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: ownerComposeId } = await store.set(
      seedCompose$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );
    const sessionId = `session_${randomUUID()}`;
    const { runId: ownerRunId } = await store.set(
      seedRun$,
      {
        orgId: ownerFixture.orgId,
        userId: ownerFixture.userId,
        composeId: ownerComposeId,
        status: "completed",
        result: { agentSessionId: sessionId },
      },
      context.signal,
    );
    mocks.clerk.session(ownerFixture.userId, ownerFixture.orgId);
    const ownerResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: ownerRunId },
      }),
      [200],
    );
    expect(ownerResponse.body.id).toBe(ownerRunId);
    expect(ownerResponse.body.agentId).toBe(ownerComposeId);
    expect(ownerResponse.body.framework).toBe("claude-code");
    expect(ownerResponse.body.status).toBe("completed");
    expect(ownerResponse.body.prompt).toBe("test prompt");
    expect(ownerResponse.body.error).toBeNull();
    expect(ownerResponse.body.sessionId).toBe(sessionId);

    // Given: a fixture + a compose with a displayName
    // + a completed run + a session for the owner.

    // When + Then: 200 — displayName is exposed.
    const displayFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: displayComposeId } = await store.set(
      seedCompose$,
      {
        orgId: displayFixture.orgId,
        userId: displayFixture.userId,
        displayName: "Agent Display Name",
      },
      context.signal,
    );
    const { runId: displayRunId } = await store.set(
      seedRun$,
      {
        orgId: displayFixture.orgId,
        userId: displayFixture.userId,
        composeId: displayComposeId,
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(displayFixture.userId, displayFixture.orgId);
    const displayResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: displayRunId },
      }),
      [200],
    );
    expect(displayResponse.body.id).toBe(displayRunId);
    expect(displayResponse.body.displayName).toBe("Agent Display Name");

    // Given: a fixture + a compose without displayName +
    // a completed run + a session for the owner.

    // When + Then: 200 — displayName is null.
    const noDisplayFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: noDisplayComposeId } = await store.set(
      seedCompose$,
      { orgId: noDisplayFixture.orgId, userId: noDisplayFixture.userId },
      context.signal,
    );
    const { runId: noDisplayRunId } = await store.set(
      seedRun$,
      {
        orgId: noDisplayFixture.orgId,
        userId: noDisplayFixture.userId,
        composeId: noDisplayComposeId,
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(noDisplayFixture.userId, noDisplayFixture.orgId);
    const noDisplayResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: noDisplayRunId },
      }),
      [200],
    );
    expect(noDisplayResponse.body.id).toBe(noDisplayRunId);
    expect(noDisplayResponse.body.displayName).toBeNull();

    // Given: a fixture + a compose + a pending run + a
    // session for the owner.

    // When + Then: 200 — status is "pending" + sessionId
    // and completedAt are both null.
    const pendingFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: pendingComposeId } = await store.set(
      seedCompose$,
      { orgId: pendingFixture.orgId, userId: pendingFixture.userId },
      context.signal,
    );
    const { runId: pendingRunId } = await store.set(
      seedRun$,
      {
        orgId: pendingFixture.orgId,
        userId: pendingFixture.userId,
        composeId: pendingComposeId,
        status: "pending",
      },
      context.signal,
    );
    mocks.clerk.session(pendingFixture.userId, pendingFixture.orgId);
    const pendingResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: pendingRunId },
      }),
      [200],
    );
    expect(pendingResponse.body.id).toBe(pendingRunId);
    expect(pendingResponse.body.status).toBe("pending");
    expect(pendingResponse.body.sessionId).toBeNull();
    expect(pendingResponse.body.completedAt).toBeNull();

    // Given: a fixture + a compose + a failed run with
    // an error message + a session for the owner.

    // When + Then: 200 — status is "failed" + the error
    // message is exposed.
    const failedFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: failedComposeId } = await store.set(
      seedCompose$,
      { orgId: failedFixture.orgId, userId: failedFixture.userId },
      context.signal,
    );
    const { runId: failedRunId } = await store.set(
      seedRun$,
      {
        orgId: failedFixture.orgId,
        userId: failedFixture.userId,
        composeId: failedComposeId,
        status: "failed",
        error: "Sandbox creation failed",
      },
      context.signal,
    );
    mocks.clerk.session(failedFixture.userId, failedFixture.orgId);
    const failedResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: failedRunId },
      }),
      [200],
    );
    expect(failedResponse.body.status).toBe("failed");
    expect(failedResponse.body.error).toBe("Sandbox creation failed");

    // Given: a fixture + a compose + a schedule + a run
    // linked to the schedule with triggerSource=schedule
    // + a session for the owner.

    // When + Then: 200 — scheduleId and
    // triggerSource="schedule" are exposed.
    const scheduleFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: scheduleComposeId } = await store.set(
      seedCompose$,
      { orgId: scheduleFixture.orgId, userId: scheduleFixture.userId },
      context.signal,
    );
    const scheduleId = await store.set(
      seedSchedule$,
      {
        orgId: scheduleFixture.orgId,
        userId: scheduleFixture.userId,
        agentId: scheduleComposeId,
        name: `sched-${randomUUID().slice(0, 8)}`,
      },
      context.signal,
    );
    const { runId: scheduleRunId } = await store.set(
      seedRun$,
      {
        orgId: scheduleFixture.orgId,
        userId: scheduleFixture.userId,
        composeId: scheduleComposeId,
        status: "completed",
        triggerSource: "schedule",
        scheduleId,
      },
      context.signal,
    );
    mocks.clerk.session(scheduleFixture.userId, scheduleFixture.orgId);
    const scheduleResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: scheduleRunId },
      }),
      [200],
    );
    expect(scheduleResponse.body.id).toBe(scheduleRunId);
    expect(scheduleResponse.body.scheduleId).toBe(scheduleId);
    expect(scheduleResponse.body.triggerSource).toBe("schedule");

    // Given: a fixture + a compose + a non-schedule run
    // + a session for the owner.

    // When + Then: 200 — scheduleId is null.
    const nonScheduleFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { composeId: nonScheduleComposeId } = await store.set(
      seedCompose$,
      { orgId: nonScheduleFixture.orgId, userId: nonScheduleFixture.userId },
      context.signal,
    );
    const { runId: nonScheduleRunId } = await store.set(
      seedRun$,
      {
        orgId: nonScheduleFixture.orgId,
        userId: nonScheduleFixture.userId,
        composeId: nonScheduleComposeId,
        status: "completed",
      },
      context.signal,
    );
    mocks.clerk.session(nonScheduleFixture.userId, nonScheduleFixture.orgId);
    const nonScheduleResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: nonScheduleRunId },
      }),
      [200],
    );
    expect(nonScheduleResponse.body.scheduleId).toBeNull();

    // Given: a fixture + an orphan run (no compose
    // version) + a session for the owner.

    // When + Then: 200 — id and prompt are exposed +
    // agentId and framework are both null.
    const orphanFixture = await trackUsage(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const { runId: orphanRunId } = await store.set(
      seedOrphanRun$,
      {
        orgId: orphanFixture.orgId,
        userId: orphanFixture.userId,
        prompt: "Orphan run prompt",
      },
      context.signal,
    );
    mocks.clerk.session(orphanFixture.userId, orphanFixture.orgId);
    const orphanResponse = await accept(
      detailClient().getById({
        headers: authHeaders(),
        params: { id: orphanRunId },
      }),
      [200],
    );
    expect(orphanResponse.body.id).toBe(orphanRunId);
    expect(orphanResponse.body.prompt).toBe("Orphan run prompt");
    expect(orphanResponse.body.agentId).toBeNull();
    expect(orphanResponse.body.framework).toBeNull();
  });
});

describe("BDD GET /api/zero/logs/:id — zero-token capability chain", () => {
  it("gwt-wt-wt: 200 with agent-run:read capability → 403 without capability → 401 no auth", async () => {
    // Given: a seeded org membership + a compose + a
    // completed run + a zero token with the
    // agent-run:read capability.

    // When + Then: 200 — the run is returned.
    const allowUserId = `user_${randomUUID()}`;
    const allowOrgId = `org_${randomUUID()}`;
    await trackOrg(
      store.set(
        seedOrgMembership$,
        { orgId: allowOrgId, userId: allowUserId, role: "member" },
        context.signal,
      ),
    );
    // Track for usage-insight cleanup too (compose/run/
    // zero_run rows).
    await trackUsage(
      Promise.resolve({ orgId: allowOrgId, userId: allowUserId }),
    );
    const { composeId: allowComposeId } = await store.set(
      seedCompose$,
      { orgId: allowOrgId, userId: allowUserId },
      context.signal,
    );
    const { runId: allowRunId } = await store.set(
      seedRun$,
      {
        orgId: allowOrgId,
        userId: allowUserId,
        composeId: allowComposeId,
        status: "completed",
        result: { agentSessionId: `session_${randomUUID()}` },
      },
      context.signal,
    );
    const allowSeconds = currentSecond();
    const allowToken = signSandboxJwtForTests({
      scope: "zero",
      userId: allowUserId,
      orgId: allowOrgId,
      runId: `run_${randomUUID()}`,
      capabilities: ["agent-run:read"],
      iat: allowSeconds,
      exp: allowSeconds + 60,
    });
    const allowedResponse = await accept(
      detailClient().getById({
        headers: { authorization: `Bearer ${allowToken}` },
        params: { id: allowRunId },
      }),
      [200],
    );
    expect(allowedResponse.body.id).toBe(allowRunId);

    // Given: a zero token with the wrong capability.

    // When + Then: 403 — FORBIDDEN.
    const denySeconds = currentSecond();
    const denyToken = signSandboxJwtForTests({
      scope: "zero",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
      iat: denySeconds,
      exp: denySeconds + 60,
    });
    const deniedResponse = await accept(
      detailClient().getById({
        headers: { authorization: `Bearer ${denyToken}` },
        params: { id: randomUUID() },
      }),
      [403],
    );
    expect(deniedResponse.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    });

    // Given: no auth header.

    // When + Then: 401.
    const noAuth = await accept(
      detailClient().getById({ headers: {}, params: { id: randomUUID() } }),
      [401],
    );
    expect(noAuth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});
