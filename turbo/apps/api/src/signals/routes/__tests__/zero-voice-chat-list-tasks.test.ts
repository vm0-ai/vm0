import { randomUUID } from "node:crypto";

import { zeroVoiceChatContract } from "@vm0/api-contracts/contracts/zero-voice-chat";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import { now } from "../../../lib/time";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteVoiceChatFixture$,
  seedVoiceChatFixture$,
  seedVoiceChatTask$,
  type VoiceChatFixture,
} from "./helpers/zero-voice-chat";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/voice-chat/:id/tasks (listTasks)", () => {
  const track = createFixtureTracker<VoiceChatFixture>((fixture) => {
    return store.set(deleteVoiceChatFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listTasks({ params: { id: randomUUID() }, headers: {} }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 401 when the authenticated session has no active organization", async () => {
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        { trinityEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, null);
    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listTasks({
        params: { id: randomUUID() },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 404 when the trinity feature switch is disabled (avoids leaking existence)", async () => {
    // Seed a real session for the user but DON'T enable Trinity.
    // Web pattern: flag-disabled tenants get 404 (not 403) so they cannot
    // distinguish "session exists" from "feature disabled".
    const fixture = await track(
      store.set(seedVoiceChatFixture$, { sessions: [{}] }, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const sessionId = fixture.sessionIds[0]!;

    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listTasks({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Voice-chat session not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 404 when the session belongs to a different user (no existence leak)", async () => {
    const otherUserId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        {
          trinityEnabled: true,
          sessions: [{ userId: otherUserId }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const otherSessionId = fixture.sessionIds[0]!;

    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listTasks({
        params: { id: otherSessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Voice-chat session not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns 404 when the session belongs to a different org (no existence leak)", async () => {
    const otherOrgId = `org_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        {
          trinityEnabled: true,
          sessions: [{ orgId: otherOrgId }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const otherOrgSessionId = fixture.sessionIds[0]!;

    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listTasks({
        params: { id: otherOrgSessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [404],
    );

    expect(response.body).toStrictEqual({
      error: {
        message: "Voice-chat session not found",
        code: "NOT_FOUND",
      },
    });
  });

  it("returns an empty list when the session has no tasks", async () => {
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        { trinityEnabled: true, sessions: [{}] },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const sessionId = fixture.sessionIds[0]!;

    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listTasks({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body).toStrictEqual({ tasks: [] });
  });

  it("returns active tasks before finished tasks", async () => {
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        { trinityEnabled: true, sessions: [{}] },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const sessionId = fixture.sessionIds[0]!;

    const doneId = await store.set(
      seedVoiceChatTask$,
      sessionId,
      { status: "done", finishedAt: new Date(now() - 100_000) },
      context.signal,
    );
    const pendingId = await store.set(
      seedVoiceChatTask$,
      sessionId,
      { status: "pending" },
      context.signal,
    );

    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listTasks({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.tasks).toHaveLength(2);
    expect(response.body.tasks[0]?.id).toBe(pendingId);
    expect(response.body.tasks[1]?.id).toBe(doneId);
  });

  it("caps finished tasks at 3 and excludes the oldest one", async () => {
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        { trinityEnabled: true, sessions: [{}] },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const sessionId = fixture.sessionIds[0]!;

    const baseTime = now();
    // Insert 4 finished tasks with distinct finishedAt timestamps; the oldest
    // should be excluded from the card feed (limit=3).
    const oldestDoneId = await store.set(
      seedVoiceChatTask$,
      sessionId,
      { status: "done", finishedAt: new Date(baseTime - 400_000) },
      context.signal,
    );
    await store.set(
      seedVoiceChatTask$,
      sessionId,
      { status: "done", finishedAt: new Date(baseTime - 300_000) },
      context.signal,
    );
    await store.set(
      seedVoiceChatTask$,
      sessionId,
      { status: "done", finishedAt: new Date(baseTime - 200_000) },
      context.signal,
    );
    await store.set(
      seedVoiceChatTask$,
      sessionId,
      { status: "done", finishedAt: new Date(baseTime - 100_000) },
      context.signal,
    );

    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listTasks({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.tasks).toHaveLength(3);
    const returnedIds = response.body.tasks.map((t) => {
      return t.id;
    });
    expect(returnedIds).not.toContain(oldestDoneId);
  });
});
