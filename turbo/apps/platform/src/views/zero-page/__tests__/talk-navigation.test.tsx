import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, fill } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

function mockChatAPIs() {
  server.use(
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads: [] });
    }),
    // Unified chat message endpoint (creates thread + run + association)
    http.post("*/api/zero/chat/messages", () => {
      return HttpResponse.json(
        {
          runId: "run-abc-123",
          threadId: "new-thread-id-123",
          status: "pending",
          createdAt: "2026-03-10T00:00:00Z",
        },
        { status: 201 },
      );
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "new-thread-id-123",
        title: "Hello",
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        unsavedRuns: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    http.get("*/api/zero/runs/:id/telemetry/agent", () => {
      return HttpResponse.json({
        events: [],
        hasMore: false,
        framework: "claude-code",
      });
    }),
    http.get("*/api/zero/runs/:id", ({ params }) => {
      return HttpResponse.json({
        id: params["id"],
        status: "completed",
        result: { agentSessionId: "session-1" },
      });
    }),
    // Return terminal status so polling loop stops immediately
    http.get("*/api/zero/logs/:id", () => {
      return HttpResponse.json({
        id: "a0000000-0000-4000-a000-000000000098",
        sessionId: "session-1",
        agentId: "zero",
        displayName: null,
        framework: "claude-code",
        modelProvider: null,
        selectedModel: null,
        triggerSource: "web",
        triggerAgentName: null,
        scheduleId: null,
        status: "completed",
        prompt: "Hello",
        appendSystemPrompt: null,
        error: null,
        createdAt: "2026-03-10T00:00:00Z",
        startedAt: "2026-03-10T00:00:01Z",
        completedAt: "2026-03-10T00:00:05Z",
        artifact: { name: null, version: null },
      });
    }),
  );
}

describe("talk navigation", () => {
  it("should navigate from /talk/:name to /chat/:chatThreadId after sending a message", async () => {
    const user = userEvent.setup();
    mockChatAPIs();

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    // Wait for the chat input to be ready
    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    // Type a message
    await fill(textarea, "Hello");

    // Press Enter to send
    await user.keyboard("{Enter}");

    // The URL should navigate to /chat/new-thread-id-123
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-id-123");
    });
  });

  it("should navigate to /agents/:id/chat after completing onboarding", async () => {
    const user = userEvent.setup();
    const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";
    // Track onboarding status: starts as needing onboarding, then completes
    let onboardingComplete = false;

    server.use(
      http.get("*/api/zero/onboarding/status", () => {
        if (onboardingComplete) {
          return HttpResponse.json({
            needsOnboarding: false,
            isAdmin: true,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: MOCK_AGENT_ID,
            defaultAgentMetadata: null,
            defaultAgentSkills: [],
          });
        }
        return HttpResponse.json({
          needsOnboarding: true,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: false,
          defaultAgentId: null,
          defaultAgentMetadata: null,
          defaultAgentSkills: [],
        });
      }),
      // Single setup endpoint
      http.post("*/api/zero/onboarding/setup", () => {
        onboardingComplete = true;
        return HttpResponse.json({ agentId: MOCK_AGENT_ID });
      }),
    );

    // Mock chat APIs for the agent chat page
    mockChatAPIs();

    detachedSetupPage({ context, path: "/" });

    // Step 1: Workspace name
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });

    // Fill name and advance
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    await fill(input, "Test Workspace");
    await user.click(screen.getByText("Next"));

    // Step 2: Choose your tools → Next
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    // Step 3: Connect your apps → Next
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Next"));

    // Step 4: Where to work
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // Click "Continue in web" which triggers:
    // 1. completeZeroOnboarding$ (single setup API call)
    // 2. navigate to /agents/:id/chat
    const continueButton = screen.getByText(/Continue in web/);
    await user.click(continueButton);

    // The final URL should be /agents/:id/chat (no auto-intro message)
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });
  });
});
