import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";

import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";

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
import {
  authHeaders,
  getZeroChatThreadThroughApi,
  listZeroChatThreadsThroughApi,
} from "./helpers/zero-chat-thread-routes";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("POST /api/zero/chat-threads (create)", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  async function listThreadsForCompose(composeId: string) {
    const body = await listZeroChatThreadsThroughApi(context, {
      agentId: composeId,
    });
    return [...body.pinned, ...body.threads];
  }

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(chatThreadsContract);

    const response = await accept(
      client.create({
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

  it("creates a chat thread as an org-scoped user", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Agent" }] },
        context.signal,
      ),
    );
    const composeId = fixture.composeIds[0]!;
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.create({
        headers: authHeaders(),
        body: { agentId: composeId, title: "My thread" },
      }),
      [201],
    );

    expect(response.body.id).toBeDefined();
    expect(response.body.title).toBe("My thread");
    expect(response.body.createdAt).toBeDefined();

    await expect(
      getZeroChatThreadThroughApi(context, response.body.id),
    ).resolves.toMatchObject({
      id: response.body.id,
      agentId: composeId,
      title: "My thread",
    });

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("uses the provided clientThreadId as the visible thread id", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Agent" }] },
        context.signal,
      ),
    );
    const composeId = fixture.composeIds[0]!;
    const clientThreadId = randomUUID();
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.create({
        headers: authHeaders(),
        body: { agentId: composeId, clientThreadId },
      }),
      [201],
    );

    expect(response.body.id).toBe(clientThreadId);
    expect(response.body.title).toBeNull();

    await expect(
      getZeroChatThreadThroughApi(context, clientThreadId),
    ).resolves.toMatchObject({
      id: clientThreadId,
      agentId: composeId,
      title: null,
    });

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
  });

  it("returns 404 for a compose owned by a different org (no existence leak)", async () => {
    const otherFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "OtherOrg agent" }] },
        context.signal,
      ),
    );
    const otherComposeId = otherFixture.composeIds[0]!;

    const myFixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "MyOrg agent" }] },
        context.signal,
      ),
    );
    mocks.clerk.session(myFixture.userId, myFixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.create({
        headers: authHeaders(),
        body: { agentId: otherComposeId, title: "Hijacked" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    mocks.clerk.session(otherFixture.userId, otherFixture.orgId);
    await expect(listThreadsForCompose(otherComposeId)).resolves.toHaveLength(
      0,
    );
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 for a non-existent compose id", async () => {
    const fixture = await track(
      store.set(seedTeamCompose$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.create({
        headers: authHeaders(),
        body: { agentId: randomUUID(), title: "x" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("returns 404 when the authenticated session has no organization (loose-auth defensive)", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Agent" }] },
        context.signal,
      ),
    );
    const composeId = fixture.composeIds[0]!;
    // Authenticate as some user with no active org — web's loose-auth path
    // returns 404 (NOT 401) because callerOrgId !== compose.orgId.
    mocks.clerk.session(`user_${randomUUID().slice(0, 8)}`, null);

    const client = setupApp({ context })(chatThreadsContract);
    const response = await accept(
      client.create({
        headers: authHeaders(),
        body: { agentId: composeId, title: "x" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    mocks.clerk.session(fixture.userId, fixture.orgId);
    await expect(listThreadsForCompose(composeId)).resolves.toHaveLength(0);
    expect(context.mocks.ably.publish).not.toHaveBeenCalled();
  });

  it("publishes threadListChanged exactly once with the right args on success", async () => {
    const fixture = await track(
      store.set(
        seedTeamCompose$,
        { composes: [{ displayName: "Agent" }] },
        context.signal,
      ),
    );
    const composeId = fixture.composeIds[0]!;
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(chatThreadsContract);
    await accept(
      client.create({
        headers: authHeaders(),
        body: { agentId: composeId },
      }),
      [201],
    );

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });
});
