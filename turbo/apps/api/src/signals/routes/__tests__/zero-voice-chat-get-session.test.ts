import { randomUUID } from "node:crypto";

import { zeroVoiceChatContract } from "@vm0/api-contracts/contracts/zero-voice-chat";
import { createStore } from "ccstate";

import { accept, setupApp, testContext } from "../../../__tests__/test-helpers";
import {
  createFixtureTracker,
  createZeroRouteMocks,
} from "./helpers/zero-route-test";
import {
  deleteVoiceChatFixture$,
  seedVoiceChatFixture$,
  type VoiceChatFixture,
} from "./helpers/zero-voice-chat";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/voice-chat/:id (getSession)", () => {
  const track = createFixtureTracker<VoiceChatFixture>((fixture) => {
    return store.set(deleteVoiceChatFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.getSession({ params: { id: randomUUID() }, headers: {} }),
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
      client.getSession({
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
      client.getSession({
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

  it("returns 404 when the session does not exist", async () => {
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        { trinityEnabled: true },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);

    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.getSession({
        params: { id: randomUUID() },
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
      client.getSession({
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
    const otherSessionId = fixture.sessionIds[0]!;

    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.getSession({
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

  it("returns the session when it belongs to the caller", async () => {
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
      client.getSession({
        params: { id: sessionId },
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.session.id).toBe(sessionId);
    expect(response.body.session.userId).toBe(fixture.userId);
    expect(response.body.session.orgId).toBe(fixture.orgId);
    // Talker payload is currently hardcoded empty in api — see follow-up
    // issue (deferred from this Stage 2 migration).
    expect(response.body.recentTaskLogs).toBe("");
    expect(response.body.finishedTasksFullText).toBe("");
    expect(response.body.talkerInstructions).toBe("");
    expect(response.body.talkerInstructionTokens).toBe(0);
  });
});
