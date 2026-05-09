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
  type VoiceChatFixture,
} from "./helpers/zero-voice-chat";

const context = testContext();
const store = createStore();
const mocks = createZeroRouteMocks(context);

describe("GET /api/zero/voice-chat (listSessions)", () => {
  const track = createFixtureTracker<VoiceChatFixture>((fixture) => {
    return store.set(deleteVoiceChatFixture$, fixture, context.signal);
  });

  it("returns 401 when the request is unauthenticated", async () => {
    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(client.listSessions({ headers: {} }), [401]);
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
      client.listSessions({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [401],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Not authenticated", code: "UNAUTHORIZED" },
    });
  });

  it("returns 403 when the trinity feature switch is disabled", async () => {
    const fixture = await track(
      store.set(seedVoiceChatFixture$, {}, context.signal),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listSessions({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [403],
    );
    expect(response.body).toStrictEqual({
      error: { message: "Voice-chat is not enabled", code: "FORBIDDEN" },
    });
  });

  it("returns an empty list when the user has no voice-chat sessions", async () => {
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
      client.listSessions({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );
    expect(response.body).toStrictEqual({ sessions: [] });
  });

  it("returns the user's voice-chat sessions ordered by createdAt desc", async () => {
    const older = new Date(now() - 100_000);
    const newer = new Date(now() - 10_000);
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        {
          trinityEnabled: true,
          sessions: [{ createdAt: older }, { createdAt: newer }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listSessions({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.sessions).toHaveLength(2);
    const [first, second] = response.body.sessions;
    expect(first?.id).toBe(fixture.sessionIds[1]);
    expect(second?.id).toBe(fixture.sessionIds[0]);
  });

  it("does not include sessions belonging to a different user in the same org", async () => {
    const otherUserId = `user_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        {
          trinityEnabled: true,
          sessions: [{}, { userId: otherUserId }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listSessions({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.sessions).toHaveLength(1);
    expect(response.body.sessions[0]?.id).toBe(fixture.sessionIds[0]);
    expect(
      response.body.sessions.map((s) => {
        return s.id;
      }),
    ).not.toContain(fixture.sessionIds[1]);
  });

  it("does not include sessions belonging to a different org", async () => {
    const otherOrgId = `org_${randomUUID()}`;
    const fixture = await track(
      store.set(
        seedVoiceChatFixture$,
        {
          trinityEnabled: true,
          sessions: [{}, { orgId: otherOrgId }],
        },
        context.signal,
      ),
    );
    mocks.clerk.session(fixture.userId, fixture.orgId);
    const client = setupApp({ context })(zeroVoiceChatContract);
    const response = await accept(
      client.listSessions({
        headers: { authorization: "Bearer clerk-session" },
      }),
      [200],
    );

    expect(response.body.sessions).toHaveLength(1);
    expect(response.body.sessions[0]?.id).toBe(fixture.sessionIds[0]);
  });
});
