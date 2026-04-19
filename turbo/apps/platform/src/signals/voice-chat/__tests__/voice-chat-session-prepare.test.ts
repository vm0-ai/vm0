import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  zeroVoiceChatPrepareTriggerContract,
  zeroVoiceChatSessionsContract,
  zeroVoiceChatContextContract,
} from "@vm0/core";
import { testContext } from "../../__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { triggerAblyEvent } from "../../../mocks/ably.ts";
import { detach, Reason } from "../../utils.ts";
import { setupVoiceChatPage$ } from "../voice-chat-setup.ts";
import {
  startVoiceChat$,
  startVoiceMeeting$,
  vcStatus$,
  vcError$,
  vcEvents$,
} from "../voice-chat-session.ts";

const context = testContext();

// Must match the defaultAgentId from the onboarding mock (api-onboarding.ts)
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

async function setup() {
  await setupPage({
    context,
    path: "/voice-chat",
    withoutRender: true,
  });
}

function mockPrepareEndpoint(
  responses: { status: "preparing" | "ready" | "failed"; id?: string }[],
) {
  let callIndex = 0;
  const calls: { agentId: string; mode: string }[] = [];
  server.use(
    mockApi(
      zeroVoiceChatPrepareTriggerContract.trigger,
      ({ body, respond }) => {
        calls.push({ agentId: body.agentId, mode: body.mode ?? "chat" });
        const responseIndex = Math.min(callIndex, responses.length - 1);
        const response = responses[responseIndex];
        callIndex++;
        return respond(200, {
          preparation: {
            id: response.id ?? "prep-1",
            status: response.status,
          },
        });
      },
    ),
  );
  return calls;
}

/**
 * Mock the session creation endpoint to return an error so startVoiceChat$
 * terminates cleanly after the preparation block. This lets us verify
 * preparation behavior without mocking the entire WebRTC session flow.
 */
function mockSessionEndpointError() {
  const sessionCalls: unknown[] = [];
  server.use(
    mockApi(zeroVoiceChatSessionsContract.create, ({ body, respond }) => {
      sessionCalls.push(body);
      return respond(400, {
        error: { message: "test-session-error", code: "BAD_REQUEST" },
      });
    }),
  );
  return sessionCalls;
}

describe("chat mode preparation cache", () => {
  describe("setupVoiceChatPage$ proactive preparation", () => {
    it("should fire preparation request on page load", async () => {
      await setup();
      const calls = mockPrepareEndpoint([{ status: "ready" }]);

      await context.store.set(setupVoiceChatPage$, context.signal);

      // Wait for fire-and-forget async to complete
      await vi.waitFor(() => {
        expect(calls.length).toBeGreaterThanOrEqual(1);
      });

      expect(calls[0]).toStrictEqual({
        agentId: DEFAULT_AGENT_ID,
        mode: "chat",
      });
    });

    it("should not block page setup when preparation fails", async () => {
      await setup();
      server.use(
        http.post("*/api/zero/voice-chat/prepare", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      // setupVoiceChatPage$ should complete without throwing
      await context.store.set(setupVoiceChatPage$, context.signal);
    });

    it("should send mode chat in preparation request", async () => {
      await setup();
      const calls = mockPrepareEndpoint([{ status: "preparing" }]);

      await context.store.set(setupVoiceChatPage$, context.signal);

      await vi.waitFor(() => {
        expect(calls.length).toBeGreaterThanOrEqual(1);
      });

      // Every call should use mode "chat"
      for (const call of calls) {
        expect(call.mode).toBe("chat");
      }
    });
  });

  describe("startVoiceChat$ preparation before session", () => {
    it("should call preparation and proceed to session when already ready", async () => {
      await setup();
      const prepCalls = mockPrepareEndpoint([{ status: "ready" }]);
      const sessionCalls = mockSessionEndpointError();

      await context.store.set(startVoiceChat$, context.signal);

      // Preparation was called
      expect(prepCalls).toHaveLength(1);
      expect(prepCalls[0]).toStrictEqual({
        agentId: DEFAULT_AGENT_ID,
        mode: "chat",
      });

      // Session creation was attempted (proves preparation didn't block)
      expect(sessionCalls).toHaveLength(1);

      // Status should be error from our mocked session endpoint
      expect(context.store.get(vcStatus$)).toBe("error");
      expect(context.store.get(vcError$)).toBe("test-session-error");
    });

    it("should poll preparation until ready then proceed to session", async () => {
      await setup();
      const prepCalls = mockPrepareEndpoint([
        { status: "preparing" },
        { status: "preparing" },
        { status: "ready" },
      ]);
      const sessionCalls = mockSessionEndpointError();

      const done = context.store.set(startVoiceChat$, context.signal);

      await vi.waitFor(() => {
        expect(prepCalls.length).toBeGreaterThanOrEqual(1);
      });
      triggerAblyEvent("voice:prep:test-user-123");
      await vi.waitFor(() => {
        expect(prepCalls.length).toBeGreaterThanOrEqual(2);
      });
      triggerAblyEvent("voice:prep:test-user-123");

      await done;

      // Initial call + 2 poll calls (preparing, ready)
      expect(prepCalls.length).toBeGreaterThanOrEqual(3);

      // Session creation was attempted after polling completed
      expect(sessionCalls).toHaveLength(1);
    });

    it("should proceed to session when preparation API fails", async () => {
      await setup();
      server.use(
        http.post("*/api/zero/voice-chat/prepare", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );
      const sessionCalls = mockSessionEndpointError();

      await context.store.set(startVoiceChat$, context.signal);

      // Session creation was still attempted (graceful fallback)
      expect(sessionCalls).toHaveLength(1);
      expect(context.store.get(vcStatus$)).toBe("error");
    });

    it("should proceed to session when preparation poll returns failed", async () => {
      await setup();
      const prepCalls = mockPrepareEndpoint([
        { status: "preparing" },
        { status: "failed" },
      ]);
      const sessionCalls = mockSessionEndpointError();

      const done = context.store.set(startVoiceChat$, context.signal);

      await vi.waitFor(() => {
        expect(prepCalls.length).toBeGreaterThanOrEqual(1);
      });
      triggerAblyEvent("voice:prep:test-user-123");

      await done;

      // Initial call + 1 poll (failed stops the loop)
      expect(prepCalls.length).toBeGreaterThanOrEqual(2);

      // Session creation was still attempted
      expect(sessionCalls).toHaveLength(1);
    });
  });

  describe("startVoiceChat$ cached preparation events", () => {
    const MOCK_EVENTS = [
      {
        id: "evt-1",
        seq: 1,
        source: "slow-brain",
        type: "slow-brain/thinking",
        content: "Reviewing agent context and preparing initial guidance...",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "evt-2",
        seq: 2,
        source: "slow-brain",
        type: "slow-brain/directive",
        content: "You are a helpful assistant.",
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        id: "evt-3",
        seq: 3,
        source: "slow-brain",
        type: "slow-brain/preparation-ready",
        content: null,
        createdAt: "2026-01-01T00:00:02Z",
      },
    ];

    function mockSessionPrepared() {
      server.use(
        mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
          return respond(200, {
            session: {
              id: "sess-cached-1",
              mode: "chat",
              status: "preparing",
              runId: "run-test-1",
              createdAt: "2026-01-01T00:00:00Z",
              prepared: true,
            },
          });
        }),
      );
    }

    function mockActivateOk() {
      const calls: string[] = [];
      server.use(
        mockApi(
          zeroVoiceChatSessionsContract.activate,
          ({ params, respond }) => {
            calls.push(params.id);
            return respond(200, {
              session: { id: params.id, mode: "chat", status: "active" },
            });
          },
        ),
      );
      return calls;
    }

    function mockContextEndpoint() {
      const calls: string[] = [];
      server.use(
        mockApi(
          zeroVoiceChatContextContract.getEvents,
          ({ params, respond }) => {
            calls.push(params.id);
            return respond(200, { events: MOCK_EVENTS });
          },
        ),
      );
      return calls;
    }

    function mockTokenEndpointError() {
      server.use(
        mockApi(zeroVoiceChatSessionsContract.token, ({ respond }) => {
          return respond(500, {
            error: {
              message: "test-token-error",
              code: "INTERNAL_SERVER_ERROR",
            },
          });
        }),
      );
    }

    function mockHeartbeat() {
      server.use(
        mockApi(zeroVoiceChatSessionsContract.heartbeat, ({ respond }) => {
          return respond(200, { ok: true });
        }),
      );
    }

    it("should pre-fetch cached events before WebRTC connection", async () => {
      await setup();
      mockPrepareEndpoint([{ status: "ready" }]);
      mockSessionPrepared();
      mockActivateOk();
      const ctxCalls = mockContextEndpoint();
      mockTokenEndpointError();
      mockHeartbeat();

      // Fire without awaiting — heartbeat loop prevents startVoiceChat$ from settling
      detach(
        context.store.set(startVoiceChat$, context.signal),
        Reason.DomCallback,
      );

      // Wait for events to be populated
      await vi.waitFor(() => {
        const events = context.store.get(vcEvents$);
        expect(events).toHaveLength(3);
      });

      // Verify context API was called for the correct session
      expect(ctxCalls).toContain("sess-cached-1");

      // Verify events match the mock data
      const events = context.store.get(vcEvents$);
      expect(events[0]).toMatchObject({
        seq: 1,
        type: "slow-brain/thinking",
      });
      expect(events[1]).toMatchObject({
        seq: 2,
        type: "slow-brain/directive",
        content: "You are a helpful assistant.",
      });
      expect(events[2]).toMatchObject({
        seq: 3,
        type: "slow-brain/preparation-ready",
      });
    });

    it("should gracefully handle context fetch failure on cached path", async () => {
      await setup();
      mockPrepareEndpoint([{ status: "ready" }]);
      mockSessionPrepared();
      mockActivateOk();
      mockHeartbeat();
      mockTokenEndpointError();

      // Mock context endpoint to fail
      server.use(
        http.get("*/api/zero/voice-chat/:sessionId/context", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      detach(
        context.store.set(startVoiceChat$, context.signal),
        Reason.DomCallback,
      );

      // Wait for the token error to propagate (connectVoiceSession$ terminates)
      await vi.waitFor(() => {
        expect(context.store.get(vcStatus$)).toBe("error");
      });

      // Events should remain empty when context fetch fails
      expect(context.store.get(vcEvents$)).toHaveLength(0);
    });
  });

  describe("startVoiceMeeting$ cached preparation events", () => {
    const MOCK_EVENTS = [
      {
        id: "evt-1",
        seq: 1,
        source: "slow-brain",
        type: "slow-brain/thinking",
        content: "Reviewing agent context and preparing initial guidance...",
        createdAt: "2026-01-01T00:00:00Z",
      },
      {
        id: "evt-2",
        seq: 2,
        source: "slow-brain",
        type: "slow-brain/directive",
        content: "You are a helpful assistant.",
        createdAt: "2026-01-01T00:00:01Z",
      },
      {
        id: "evt-3",
        seq: 3,
        source: "slow-brain",
        type: "slow-brain/preparation-ready",
        content: null,
        createdAt: "2026-01-01T00:00:02Z",
      },
    ];

    function mockMeetingSessionPrepared() {
      server.use(
        mockApi(zeroVoiceChatSessionsContract.create, ({ respond }) => {
          return respond(200, {
            session: {
              id: "sess-meeting-cached-1",
              mode: "meeting",
              status: "preparing",
              runId: "run-test-1",
              createdAt: "2026-01-01T00:00:00Z",
              prepared: true,
            },
          });
        }),
      );
    }

    function mockActivateOk() {
      const calls: string[] = [];
      server.use(
        mockApi(
          zeroVoiceChatSessionsContract.activate,
          ({ params, respond }) => {
            calls.push(params.id);
            return respond(200, {
              session: { id: params.id, mode: "meeting", status: "active" },
            });
          },
        ),
      );
      return calls;
    }

    function mockContextEndpoint() {
      const calls: string[] = [];
      server.use(
        mockApi(
          zeroVoiceChatContextContract.getEvents,
          ({ params, respond }) => {
            calls.push(params.id);
            return respond(200, { events: MOCK_EVENTS });
          },
        ),
      );
      return calls;
    }

    function mockTokenEndpointError() {
      server.use(
        mockApi(zeroVoiceChatSessionsContract.token, ({ respond }) => {
          return respond(500, {
            error: {
              message: "test-token-error",
              code: "INTERNAL_SERVER_ERROR",
            },
          });
        }),
      );
    }

    function mockHeartbeat() {
      server.use(
        mockApi(zeroVoiceChatSessionsContract.heartbeat, ({ respond }) => {
          return respond(200, { ok: true });
        }),
      );
    }

    it("should pre-fetch cached events before WebRTC connection", async () => {
      await setup();
      mockMeetingSessionPrepared();
      mockActivateOk();
      const ctxCalls = mockContextEndpoint();
      mockTokenEndpointError();
      mockHeartbeat();

      // startVoiceMeeting$ takes a prompt and signal (no preparation trigger)
      detach(
        context.store.set(startVoiceMeeting$, "test prompt", context.signal),
        Reason.DomCallback,
      );

      // Wait for events to be populated
      await vi.waitFor(() => {
        const events = context.store.get(vcEvents$);
        expect(events).toHaveLength(3);
      });

      // Verify context API was called for the correct session
      expect(ctxCalls).toContain("sess-meeting-cached-1");

      // Verify events match the mock data
      const events = context.store.get(vcEvents$);
      expect(events[0]).toMatchObject({
        seq: 1,
        type: "slow-brain/thinking",
      });
      expect(events[2]).toMatchObject({
        seq: 3,
        type: "slow-brain/preparation-ready",
      });
    });
  });
});
