import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setupVoiceChatPage$ } from "../voice-chat-setup.ts";
import { startVoiceChat$, vcStatus$, vcError$ } from "../voice-chat-session.ts";

const context = testContext();

// Must match the defaultAgentId from the onboarding mock (api-onboarding.ts)
const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";

function setup() {
  detachedSetupPage({
    context,
    path: "/voice-chat",
    withoutRender: true,
  });
}

function mockPrepareEndpoint(responses: { status: string; id?: string }[]) {
  let callIndex = 0;
  const calls: { agentId: string; mode: string }[] = [];
  server.use(
    http.post("*/api/zero/voice-chat/prepare", async ({ request }) => {
      const body = (await request.json()) as {
        agentId: string;
        mode: string;
      };
      calls.push(body);
      const responseIndex = Math.min(callIndex, responses.length - 1);
      const response = responses[responseIndex];
      callIndex++;
      return HttpResponse.json({
        preparation: {
          id: response.id ?? "prep-1",
          status: response.status,
        },
      });
    }),
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
    http.post("*/api/zero/voice-chat", async ({ request }) => {
      const body = await request.json();
      sessionCalls.push(body);
      return HttpResponse.json(
        { error: { message: "test-session-error" } },
        { status: 400 },
      );
    }),
  );
  return sessionCalls;
}

describe("chat mode preparation cache", () => {
  describe("setupVoiceChatPage$ proactive preparation", () => {
    it("should fire preparation request on page load", async () => {
      setup();
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
      setup();
      server.use(
        http.post("*/api/zero/voice-chat/prepare", () => {
          return new HttpResponse(null, { status: 500 });
        }),
      );

      // setupVoiceChatPage$ should complete without throwing
      await context.store.set(setupVoiceChatPage$, context.signal);
    });

    it("should send mode chat in preparation request", async () => {
      setup();
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
      setup();
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
      setup();
      const prepCalls = mockPrepareEndpoint([
        { status: "preparing" },
        { status: "preparing" },
        { status: "ready" },
      ]);
      const sessionCalls = mockSessionEndpointError();

      await context.store.set(startVoiceChat$, context.signal);

      // Initial call + 2 poll calls (preparing, ready)
      expect(prepCalls.length).toBeGreaterThanOrEqual(3);

      // Session creation was attempted after polling completed
      expect(sessionCalls).toHaveLength(1);
    });

    it("should proceed to session when preparation API fails", async () => {
      setup();
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
      setup();
      const prepCalls = mockPrepareEndpoint([
        { status: "preparing" },
        { status: "failed" },
      ]);
      const sessionCalls = mockSessionEndpointError();

      await context.store.set(startVoiceChat$, context.signal);

      // Initial call + 1 poll (failed stops the loop)
      expect(prepCalls.length).toBeGreaterThanOrEqual(2);

      // Session creation was still attempted
      expect(sessionCalls).toHaveLength(1);
    });
  });
});
