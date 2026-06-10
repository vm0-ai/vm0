import { randomUUID } from "node:crypto";

import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import { createStore } from "ccstate";

import { createApp } from "../../../app-factory";
import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteQueuePositionRuns$,
  seedQueuePositionRuns$,
  type QueuePositionFixture,
} from "./helpers/zero-queue-position";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-queue-position.test.ts`. The Given
// uses `seedQueuePositionRuns$` — recorded under "Open Helper Gaps" in
// `api.bdd.md` (no public route creates a queued run for the test).
// The 7 legacy `it()`s collapse into 2 BDD `it()`s (auth boundary +
// a gwt-wt-wt chain that exercises queued / unqueued / cross-user /
// cross-org / unknown id in one shared session).

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function client() {
  return setupApp({ context })(zeroQueuePositionContract);
}

describe("BDD GET /api/zero/queue-position — auth boundary", () => {
  it("rejects unauthenticated requests and missing required params", async () => {
    const c = client();

    // When + Then: no auth header → 401.
    const unauth = await accept(
      c.getPosition({ query: { runId: randomUUID() }, headers: {} }),
      [401],
    );
    expect(unauth.body.error.code).toBe("UNAUTHORIZED");

    // When + Then: runId is a required query param; hitting the route
    // without it returns 400. The contract requires runId, so we hit
    // the route directly to exercise the boundary.
    const app = createApp({ signal: context.signal });
    const noRunId = await app.request("/api/zero/queue-position", {
      method: "GET",
    });
    expect(noRunId.status).toBe(400);
    const noRunIdBody: unknown = await noRunId.json();
    expect(noRunIdBody).toMatchObject({ error: { code: "BAD_REQUEST" } });
    expect(JSON.stringify(noRunIdBody)).toContain("runId");
  });
});

const track = createFixtureTracker<QueuePositionFixture>((fixture) => {
  return store.set(deleteQueuePositionRuns$, fixture, context.signal);
});

describe("BDD GET /api/zero/queue-position — read chain", () => {
  it("gwt-wt-wt: queued run → unqueued run → 404 cross-user → 404 cross-org → 404 unknown", async () => {
    const c = client();

    // Given: 2 queued runs in the fixture.
    const queuedFixture = await track(
      store.set(seedQueuePositionRuns$, { queuedRuns: 2 }, context.signal),
    );
    mocks.clerk.session(queuedFixture.userId, queuedFixture.orgId);
    const queuedRunId = queuedFixture.queuedRunIds[1];
    if (!queuedRunId) {
      throw new Error("Expected queued run fixture");
    }

    // When + Then: the second queued run reports position=2/total=2.
    const queued = await accept(
      c.getPosition({ query: { runId: queuedRunId }, headers: authHeaders() }),
      [200],
    );
    expect(queued.body).toStrictEqual({ position: 2, total: 2 });

    // Given: an unqueued run owned by the same caller.
    const unqueuedFixture = await track(
      store.set(seedQueuePositionRuns$, { unqueuedRuns: 1 }, context.signal),
    );
    mocks.clerk.session(unqueuedFixture.userId, unqueuedFixture.orgId);
    const unqueuedRunId = unqueuedFixture.unqueuedRunIds[0];
    if (!unqueuedRunId) {
      throw new Error("Expected unqueued run fixture");
    }

    // When + Then: GET returns position=0/total=0.
    const unqueued = await accept(
      c.getPosition({
        query: { runId: unqueuedRunId },
        headers: authHeaders(),
      }),
      [200],
    );
    expect(unqueued.body).toStrictEqual({ position: 0, total: 0 });

    // Given: a queued run in a fixture org; a different user in the
    // same org requests it.
    const otherUserFixture = await track(
      store.set(seedQueuePositionRuns$, { queuedRuns: 1 }, context.signal),
    );
    mocks.clerk.session(`user_${randomUUID()}`, otherUserFixture.orgId);
    const crossUserRunId = otherUserFixture.queuedRunIds[0];
    if (!crossUserRunId) {
      throw new Error("Expected queued run fixture");
    }

    // When + Then: 404 (no existence leak across users).
    const crossUser = await accept(
      c.getPosition({
        query: { runId: crossUserRunId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossUser.body.error.code).toBe("NOT_FOUND");

    // Given: a queued run in a different org; the caller is on
    // their own org.
    const crossOrgFixture = await track(
      store.set(seedQueuePositionRuns$, { queuedRuns: 1 }, context.signal),
    );
    mocks.clerk.session(crossOrgFixture.userId, `org_${randomUUID()}`);
    const crossOrgRunId = crossOrgFixture.queuedRunIds[0];
    if (!crossOrgRunId) {
      throw new Error("Expected queued run fixture");
    }

    // When + Then: 404.
    const crossOrg = await accept(
      c.getPosition({
        query: { runId: crossOrgRunId },
        headers: authHeaders(),
      }),
      [404],
    );
    expect(crossOrg.body.error.code).toBe("NOT_FOUND");

    // Given: an authenticated session with no runs seeded.
    const emptyFixture = await track(
      store.set(seedQueuePositionRuns$, {}, context.signal),
    );
    mocks.clerk.session(emptyFixture.userId, emptyFixture.orgId);

    // When + Then: an unknown runId returns 404.
    const unknown = await accept(
      c.getPosition({ query: { runId: randomUUID() }, headers: authHeaders() }),
      [404],
    );
    expect(unknown.body.error.code).toBe("NOT_FOUND");
  });
});
