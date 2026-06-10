import { randomUUID } from "node:crypto";

import { zeroRunsByIdContract } from "@vm0/api-contracts/contracts/zero-runs";
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

// BDD migration of the legacy `zero-runs-by-id.test.ts`.
// The 7 legacy `it()`s collapse into 2 BDD `it()`s: (1)
// auth boundary (401 unauth → 401 no-org), (2) full
// coverage chain (400 invalid id → 404 unknown → 404
// cross-user no-leak → 200 owner reads own run → 403
// sandbox without `agent-run:read`).
//
// The Given uses `seedUsageInsightFixture$` +
// `seedCompose$` + `seedRun$` direct DB writes (Open
// Helper Gaps — the public API does not expose a
// "create a run for a fixture" primitive). The Then
// step is always through the public
// `zeroRunsByIdContract.getById` response.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroRunsByIdContract);
}

function currentSecond(): number {
  return Math.floor(now() / 1000);
}

const track = createFixtureTracker<UsageInsightFixture>((fixture) => {
  return store.set(deleteUsageInsightFixture$, fixture, context.signal);
});

describe("BDD GET /api/zero/runs/:id — auth boundary", () => {
  it("rejects unauthenticated and org-less sessions", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.getById({ params: { id: randomUUID() }, headers: {} }),
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
      c.getById({
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

describe("BDD GET /api/zero/runs/:id — full coverage chain", () => {
  it("gwt-wt-wt: 400 invalid id → 404 unknown → 404 cross-user → 200 owner → 403 sandbox no capability", async () => {
    // Given: a fresh fixture + a valid session.
    const fixture = await track(
      store.set(seedUsageInsightFixture$, undefined, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const c = client();

    // When + Then: a non-UUID id returns 400.
    const badId = await accept(
      c.getById({ params: { id: "2b9b2303" }, headers: authHeaders() }),
      [400],
    );
    expect(badId.body.error.code).toBe("BAD_REQUEST");

    // When + Then: an unknown id returns 404.
    const unknown = await accept(
      c.getById({ params: { id: randomUUID() }, headers: authHeaders() }),
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
      },
      context.signal,
    );

    // When + Then: a different user gets 404 (no existence
    // leak).
    const crossUser = await accept(
      c.getById({ params: { id: ownerRunId }, headers: authHeaders() }),
      [404],
    );
    expect(crossUser.body).toStrictEqual({
      error: { message: "Agent run not found", code: "NOT_FOUND" },
    });

    // Given: a run owned by the current user.
    const ownCompose = await store.set(
      seedCompose$,
      { orgId: fixture.orgId, userId: fixture.userId },
      context.signal,
    );
    const { runId: ownRunId } = await store.set(
      seedRun$,
      {
        orgId: fixture.orgId,
        userId: fixture.userId,
        composeId: ownCompose.composeId,
        status: "running",
      },
      context.signal,
    );

    // When + Then: the owner gets 200 with the run
    // details.
    const owner = await accept(
      c.getById({ params: { id: ownRunId }, headers: authHeaders() }),
      [200],
    );
    expect(owner.body.runId).toBe(ownRunId);
    expect(owner.body.status).toBe("running");
    expect(owner.body.prompt).toBe("test prompt");

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

    // When + Then: the route returns 403.
    const sandbox = await accept(
      c.getById({
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
