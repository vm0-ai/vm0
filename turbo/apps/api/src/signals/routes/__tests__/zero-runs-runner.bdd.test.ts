import { randomUUID } from "node:crypto";

import { zeroRunRunnerContract } from "@vm0/api-contracts/contracts/zero-runs";
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

// BDD migration of the legacy `zero-runs-runner.test.ts`.
// The 7 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// auth boundary (401 unauth → 401 no-org), (2) full
// coverage chain (200 sandboxReuseResult="reused" → 200
// sandboxReuseResult=null for runs that never set it →
// 404 unknown → 404 cross-user no-leak → 403 sandbox
// without `agent-run:read`).
//
// The Given uses `seedUsageInsightFixture$` +
// `seedCompose$` + `seedRun$` direct DB writes (Open
// Helper Gaps). The Then step is always through the
// public `zeroRunRunnerContract.getRunner` response.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroRunRunnerContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/runs/:id/runner — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.getRunner({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });

    // Given: a session that resolves to a user without an org.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, null);

    // When + Then: still 401.
    const noOrg = await accept(
      c.getRunner({
        params: { id: randomUUID() },
        headers: authHeaders(),
      }),
      [401],
    );
    expect(noOrg.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });
});

describe("BDD GET /api/zero/runs/:id/runner — full coverage chain", () => {
  it("gwt-wt-wt: 200 reused → 200 null → 404 unknown → 404 cross-user → 403 sandbox no capability", async () => {
    // Given: a fresh fixture + a run with
    // sandboxReuseResult="reused".
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const compose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "completed",
        sandboxReuseResult: "reused",
      },
      context.signal,
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const c = client();

    // When + Then: the runner field is "reused".
    const reused = await accept(
      c.getRunner({ params: { id: runId }, headers: authHeaders() }),
      [200],
    );
    expect(reused.body).toStrictEqual({ sandboxReuseResult: "reused" });

    // Given: a run with no sandboxReuseResult set.
    const { runId: nullRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: compose.composeId,
        status: "completed",
      },
      context.signal,
    );

    // When + Then: the runner field is null.
    const nullField = await accept(
      c.getRunner({ params: { id: nullRunId }, headers: authHeaders() }),
      [200],
    );
    expect(nullField.body).toStrictEqual({ sandboxReuseResult: null });

    // When + Then: 404 — an unknown id.
    const unknown = await accept(
      c.getRunner({ params: { id: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(unknown.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    // Given: a run owned by another user.
    const ownerFixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    const ownerCompose = await store.set(
      seedCompose$,
      { orgId: ownerFixture.orgId, userId: ownerFixture.userId },
      context.signal,
    );
    const { runId: ownerRunId } = await store.set(
      seedRun$,
      {
        orgId: ownerFixture.orgId,
        userId: ownerFixture.userId,
        composeId: ownerCompose.composeId,
        status: "completed",
        sandboxReuseResult: "poolMiss",
      },
      context.signal,
    );

    // When + Then: 404 — a different user gets no
    // existence leak.
    const crossUser = await accept(
      c.getRunner({ params: { id: ownerRunId }, headers: authHeaders() }),
      [404],
    );
    expect(crossUser.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    // Given: a sandbox token with `file:read` but not
    // `agent-run:read`.
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

    // When + Then: 403.
    const sandbox = await accept(
      c.getRunner({
        params: { id: randomUUID() },
        headers: { authorization: `Bearer ${sandboxToken}` },
      }),
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
