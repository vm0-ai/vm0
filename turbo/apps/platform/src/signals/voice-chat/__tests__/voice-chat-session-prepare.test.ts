import { describe, it, expect, vi } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { detachedSetupPage } from "../../../__tests__/page-helper.ts";
import { setChatAgentId$ } from "../../agent-chat.ts";
import { setupVoiceChatPage$ } from "../voice-chat-setup.ts";

const context = testContext();

const TEST_AGENT_ID = "agent-prep-123";

function setup() {
  detachedSetupPage({
    context,
    path: "/voice-chat",
    withoutRender: true,
  });
  context.store.set(setChatAgentId$, TEST_AGENT_ID);
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
        agentId: TEST_AGENT_ID,
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
});
