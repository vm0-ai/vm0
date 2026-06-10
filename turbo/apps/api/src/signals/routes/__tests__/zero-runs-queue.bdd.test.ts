import { randomUUID } from "node:crypto";

import { zeroRunsQueueContract } from "@vm0/api-contracts/contracts/zero-runs";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import { signSandboxJwtForTests } from "../../auth/tokens";
import {
  deleteUsageInsightFixture$,
  seedCompose$,
  seedRun$,
  seedUsageInsightFixture$,
  type UsageInsightFixture,
} from "./helpers/zero-usage-insight";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-runs-queue.test.ts`. The Given
// uses `seedUsageInsightFixture$` (a transitional DB-seed helper) and
// `seedCompose$` / `seedRun$` — both are recorded under "Open Helper
// Gaps" in `api.bdd.md`. The Then step is always through the public
// `zeroRunsQueueContract.getQueue` response.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroRunsQueueContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

describe("BDD GET /api/zero/runs/queue — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(c.getQueue({ headers: {} }), [401]);
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without an org.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: the route still returns 401.
    const noOrg = await accept(c.getQueue({ headers: authHeaders() }), [401]);
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/runs/queue — queue shape chain", () => {
  it("gwt-wt-wt: empty queue → 1 running task owned by caller → sandbox 403", async () => {
    // Given: a fresh user/org with no runs.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const c = client();

    // When + Then: the queue is empty; concurrency reports tier=free
    // with limit=1, available=1, and no estimated time per run.
    const empty = await accept(c.getQueue({ headers: authHeaders() }), [200]);
    expect(empty.body).toStrictEqual({
      concurrency: {
        tier: "free",
        limit: 1,
        active: 0,
        available: 1,
      },
      queue: [],
      runningTasks: [],
      estimatedTimePerRun: null,
    });

    // Given: one running task owned by the caller.
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "running",
      },
      context.signal,
    );

    // When + Then: the queue reports the running task with
    // `isOwner=true` and concurrency.active=1.
    const running = await accept(c.getQueue({ headers: authHeaders() }), [200]);
    expect(running.body.concurrency.active).toBe(1);
    expect(running.body.runningTasks).toHaveLength(1);
    const [firstRunning] = running.body.runningTasks;
    expect(firstRunning?.isOwner).toBeTruthy();

    // Given: a sandbox token with `file:read` but not `agent-run:read`.
    const seconds = currentSecond();
    const sandboxToken = signSandboxJwtForTests({
      scope: "zero",
      userId: `user_${randomUUID()}`,
      orgId: `org_${randomUUID()}`,
      runId: `run_${randomUUID()}`,
      capabilities: ["file:read"],
      iat: seconds,
      exp: seconds + 60,
    });

    // When + Then: the route returns 403.
    const sandbox = await accept(
      c.getQueue({ headers: { authorization: `Bearer ${sandboxToken}` } }),
      [403],
    );
    expect(sandbox.body).toStrictEqual({
      error: {
        message: "Missing required capability: agent-run:read",
        code: "FORBIDDEN",
      },
    });
  });
});
