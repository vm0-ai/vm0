import { randomUUID } from "node:crypto";

import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

// BDD migration of the legacy `zero-chat-threads-create.test.ts`. The
// legacy direct DB SELECTs that verified the persisted thread row and
// the cross-org / no-org 404 row counts are replaced by assertions on
// the public list endpoint (created thread shows up; cross-org compose
// leaves the public list empty; no-org compose also leaves it empty).
// The 7 legacy `it()`s collapse into 2 BDD `it()`s.

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

function authHeaders(): { readonly authorization: string } {
  return { authorization: "Bearer clerk-session" };
}

function createClient() {
  return setupApp({ context })(chatThreadsContract);
}

function listClient() {
  return setupApp({ context })(chatThreadsContract);
}

describe("BDD POST /api/zero/chat-threads — auth boundary", () => {
  it("returns 401 when unauthenticated and does not publish to Ably", async () => {
    context.mocks.ably.publish.mockClear();

    // When + Then: no auth header → 401 and no Ably publish.
    const response = await accept(
      createClient().create({
        headers: {},
        body: { agentId: randomUUID(), title: "x" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });
});

const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
  return store.set(deleteTeamCompose$, fixture, context.signal);
});

describe("BDD POST /api/zero/chat-threads — create chain", () => {
  it("gwt-wt-wt: 404 unknown compose → 201 with title (verified via list) → 201 with clientThreadId → 404 cross-org (list empty) → 404 no-org (list empty)", async () => {
    const c = createClient();
    const lister = listClient();
    context.mocks.ably.publish.mockClear();

    // Given: a fresh user/org with a compose.
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Agent" }] },
        context.signal,
      ),
    );
    const composeId = fixture.composeIds[0]!;
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: 404 for a non-existent compose id.
    const unknown = await accept(
      c.create({
        headers: authHeaders(),
        body: { agentId: randomUUID(), title: "x" },
      }),
      [404],
    );
    expect(unknown.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // When: the caller creates a thread with a title.
    const withTitle = await accept(
      c.create({
        headers: authHeaders(),
        body: { agentId: composeId, title: "My thread" },
      }),
      [201],
    );
    expect(withTitle.body.id).toBeDefined();
    expect(withTitle.body.title).toBe("My thread");
    expect(withTitle.body.createdAt).toBeDefined();

    // Then: the list endpoint shows the new thread and the Ably
    // publish was made exactly once.
    const afterCreate = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const listThread = [
      ...afterCreate.body.pinned,
      ...afterCreate.body.threads,
    ].find((entry) => {
      return entry.id === withTitle.body.id;
    });
    expect(listThread?.title).toBe("My thread");
    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
    context.mocks.ably.publish.mockClear();

    // When: the caller creates a thread with an explicit
    // `clientThreadId`.
    const clientThreadId = randomUUID();
    const withClientId = await accept(
      c.create({
        headers: authHeaders(),
        body: { agentId: composeId, clientThreadId },
      }),
      [201],
    );
    expect(withClientId.body.id).toBe(clientThreadId);
    expect(withClientId.body.title).toBeNull();
    context.mocks.ably.publish.mockClear();

    // Given: another org owns a compose; the caller is on their own org.
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "OtherOrg agent" }] },
        context.signal,
      ),
    );
    const otherComposeId = otherFixture.composeIds[0]!;
    mocks.clerk.session(fixture.userId, fixture.orgId);

    // When + Then: cross-org compose returns 404 and no Ably publish.
    const crossOrg = await accept(
      c.create({
        headers: authHeaders(),
        body: { agentId: otherComposeId, title: "Hijacked" },
      }),
      [404],
    );
    expect(crossOrg.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Then: re-authenticate as the cross-org owner and confirm the
    // public list shows zero threads for the cross-org compose
    // (create was rejected, so the count is empty).
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    const otherOrgList = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const otherOrgThreads = [
      ...otherOrgList.body.pinned,
      ...otherOrgList.body.threads,
    ];
    expect(otherOrgThreads).toHaveLength(0);

    // Given: a session with no active org.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, null);

    // When + Then: 404 for the org-less session against the caller's
    // own compose (loose-auth defensive — no row is created).
    const noOrg = await accept(
      c.create({
        headers: authHeaders(),
        body: { agentId: composeId, title: "x" },
      }),
      [404],
    );
    expect(noOrg.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();

    // Re-authenticate as the org owner and confirm the list still
    // shows only the two threads created above (no org-less row
    // leaked in).
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const finalList = await accept(
      lister.list({ headers: authHeaders() }),
      [200],
    );
    const finalThreads = [...finalList.body.pinned, ...finalList.body.threads];
    expect(finalThreads).toHaveLength(2);
  });
});
