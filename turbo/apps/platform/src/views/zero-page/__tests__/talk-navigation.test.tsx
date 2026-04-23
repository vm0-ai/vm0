import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  detachedSetupPage,
  fill,
  click,
} from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadByIdContract,
  chatMessagesContract,
  zeroRunAgentEventsContract,
  zeroRunsByIdContract,
  logsByIdContract,
  onboardingStatusContract,
  onboardingSetupContract,
} from "@vm0/core";

const context = testContext();
const mockApi = createMockApi(context);

const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

function mockChatAPIs() {
  server.use(
    // Unified chat message endpoint (creates thread + run + association)
    mockApi(chatMessagesContract.send, ({ respond }) => {
      return respond(201, {
        runId: "run-abc-123",
        threadId: "new-thread-id-123",
        status: "pending",
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: "new-thread-id-123",
        title: "Hello",
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(200, {
        events: [],
        hasMore: false,
        framework: "claude-code",
      });
    }),
    mockApi(zeroRunsByIdContract.getById, ({ params, respond }) => {
      return respond(200, {
        runId: params.id,
        agentComposeVersionId: null,
        status: "completed",
        prompt: "Hello",
        appendSystemPrompt: null,
        result: { agentSessionId: "session-1" },
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
    // Return terminal status so polling loop stops immediately
    mockApi(logsByIdContract.getById, ({ respond }) => {
      return respond(200, {
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
    const MOCK_AGENT_ID = "d0000000-0000-4000-a000-000000000001";
    // Track onboarding status: starts as needing onboarding, then completes
    let onboardingComplete = false;

    server.use(
      mockApi(onboardingStatusContract.getStatus, ({ respond }) => {
        if (onboardingComplete) {
          return respond(200, {
            needsOnboarding: false,
            isAdmin: true,
            hasOrg: true,
            hasDefaultAgent: true,
            defaultAgentId: MOCK_AGENT_ID,
            defaultAgentMetadata: null,
          });
        }
        return respond(200, {
          needsOnboarding: true,
          isAdmin: true,
          hasOrg: true,
          hasDefaultAgent: false,
          defaultAgentId: null,
          defaultAgentMetadata: null,
        });
      }),
      // Single setup endpoint
      mockApi(onboardingSetupContract.setup, ({ respond }) => {
        onboardingComplete = true;
        return respond(200, { agentId: MOCK_AGENT_ID });
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
    click(screen.getByText("Next"));

    // Step 2: Choose your tools — select a connector so step 3 is reachable
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    click(screen.getByTestId("connector-card-github"));
    click(screen.getByText("Next"));

    // Step 3: Connect your apps → Next
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    click(screen.getByText("Next"));

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
    click(continueButton);

    // The final URL should be /agents/:id/chat (no auto-intro message)
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${MOCK_AGENT_ID}/chat`);
    });
  });
});
