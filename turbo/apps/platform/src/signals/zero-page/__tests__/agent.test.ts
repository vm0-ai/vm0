import { command } from "ccstate";
import { describe, it, expect } from "vitest";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../__tests__/test-helpers.ts";
import { createPushStateMock } from "../../../__tests__/page-helper.ts";
import { zeroChatAgentId$ } from "../zero-active-agent.ts";
import { setRootSignal$ } from "../../root-signal.ts";
import { initRoutes$ } from "../../route.ts";
import { mockLocation } from "../../location.ts";

const context = testContext();

function mockOnboardingStatus(defaultAgentId: string) {
  server.use(
    http.get("*/api/zero/onboarding/status", () => {
      return HttpResponse.json({
        needsOnboarding: false,
        isAdmin: true,
        hasOrg: true,
        hasDefaultAgent: true,
        defaultAgentId,
        defaultAgentMetadata: { displayName: "Zero" },
        defaultAgentSkills: [],
      });
    }),
  );
}

function mockChatThread(threadId: string, agentId: string) {
  server.use(
    http.get(`*/api/zero/chat-threads/${threadId}`, () => {
      return HttpResponse.json({
        id: threadId,
        agentId,
        chatMessages: [],
        latestSessionId: null,
        unsavedRuns: [],
      });
    }),
  );
}

async function setupRoutes(pathname: string) {
  context.store.set(setRootSignal$, context.signal);
  createPushStateMock(context.signal);
  mockLocation({ pathname, search: "" }, context.signal);
  const noop$ = command(() => {
    return void 0;
  });
  await context.store.set(
    initRoutes$,
    [
      { path: "/", setup: noop$ },
      { path: "/agents/:id/chat", setup: noop$ },
      { path: "/chats/:id", setup: noop$ },
      { path: "{/*path}", setup: noop$ },
    ],
    context.signal,
  );
}

describe("zeroChatAgentId$", () => {
  it("should return null for / (no agent)", async () => {
    await setupRoutes("/");

    const agentId = await context.store.get(zeroChatAgentId$);
    expect(agentId).toBeNull();
  });

  it("should return agentId from /agents/:id/chat (non-default)", async () => {
    mockOnboardingStatus("c0000000-0000-4000-a000-000000000001");
    await setupRoutes("/agents/sub-agent-id/chat");

    const agentId = await context.store.get(zeroChatAgentId$);
    expect(agentId).toBe("sub-agent-id");
  });

  it("should return null for /talk/:defaultAgentId (default normalization)", async () => {
    mockOnboardingStatus("c0000000-0000-4000-a000-000000000001");
    await setupRoutes("/agents/c0000000-0000-4000-a000-000000000001/chat");

    const agentId = await context.store.get(zeroChatAgentId$);
    expect(agentId).toBeNull();
  });

  it("should return thread agentId from /chats/:id (non-default)", async () => {
    mockOnboardingStatus("c0000000-0000-4000-a000-000000000001");
    mockChatThread("thread-abc", "sub-agent-id");
    await setupRoutes("/chats/thread-abc");

    const agentId = await context.store.get(zeroChatAgentId$);
    expect(agentId).toBe("sub-agent-id");
  });

  it("should return null when /chats/:id has default agent", async () => {
    mockOnboardingStatus("c0000000-0000-4000-a000-000000000001");
    mockChatThread("thread-abc", "c0000000-0000-4000-a000-000000000001");
    await setupRoutes("/chats/thread-abc");

    const agentId = await context.store.get(zeroChatAgentId$);
    expect(agentId).toBeNull();
  });
});
