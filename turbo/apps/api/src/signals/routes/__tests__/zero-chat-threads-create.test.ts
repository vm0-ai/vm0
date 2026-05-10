import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createStore } from "ccstate";
import { eq } from "drizzle-orm";

import { chatThreadsContract } from "@vm0/api-contracts/contracts/chat-threads";
import { chatThreads } from "@vm0/db/schema/chat-thread";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { writeDb$ } from "../../external/db";
import {
  deleteTeamCompose$,
  seedTeamCompose$,
  type TeamComposeFixture,
} from "./helpers/zero-team";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("POST /api/zero/chat-threads (create)", () => {
  const track = createFixtureTracker<TeamComposeFixture>((fixture) => {
    return store.set(deleteTeamCompose$, fixture, context.signal);
  });

  async function getThreadRow(threadId: string) {
    const writeDb = store.set(writeDb$);
    const [row] = await writeDb
      .select({
        id: chatThreads.id,
        userId: chatThreads.userId,
        agentComposeId: chatThreads.agentComposeId,
        title: chatThreads.title,
      })
      .from(chatThreads)
      .where(eq(chatThreads.id, threadId));
    return row;
  }

  async function countThreadsForCompose(composeId: string): Promise<number> {
    const writeDb = store.set(writeDb$);
    const rows = await writeDb
      .select({ id: chatThreads.id })
      .from(chatThreads)
      .where(eq(chatThreads.agentComposeId, composeId));
    return rows.length;
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

  it("creates a chat thread as an org-scoped user (DB read-after-write)", async () => {
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
        headers: { authorization: "Bearer clerk-session" },
        body: { agentId: composeId, title: "My thread" },
      }),
      [201],
    );

    expect(response.body.id).toBeDefined();
    expect(response.body.title).toBe("My thread");
    expect(response.body.createdAt).toBeDefined();

    await expect(getThreadRow(response.body.id)).resolves.toMatchObject({
      id: response.body.id,
      userId: fixture.userId,
      agentComposeId: composeId,
      title: "My thread",
    });

    expect(context.mocks.ably.publish).toHaveBeenCalledTimes(1);
    expect(context.mocks.ably.publish).toHaveBeenCalledWith(
      "threadListChanged",
      null,
    );
  });

  it("forwards the provided clientThreadId into the DB row", async () => {
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
        headers: { authorization: "Bearer clerk-session" },
        body: { agentId: composeId, clientThreadId },
      }),
      [201],
    );

    expect(response.body.id).toBe(clientThreadId);
    expect(response.body.title).toBeNull();

    await expect(getThreadRow(clientThreadId)).resolves.toMatchObject({
      id: clientThreadId,
      agentComposeId: composeId,
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
        headers: { authorization: "Bearer clerk-session" },
        body: { agentId: otherComposeId, title: "Hijacked" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    await expect(countThreadsForCompose(otherComposeId)).resolves.toBe(0);
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
        headers: { authorization: "Bearer clerk-session" },
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
        headers: { authorization: "Bearer clerk-session" },
        body: { agentId: composeId, title: "x" },
      }),
      [404],
    );

    expect(response.body).toMatchObject({
      error: { message: "Agent not found", code: "NOT_FOUND" },
    });
    await expect(countThreadsForCompose(composeId)).resolves.toBe(0);
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
        headers: { authorization: "Bearer clerk-session" },
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
