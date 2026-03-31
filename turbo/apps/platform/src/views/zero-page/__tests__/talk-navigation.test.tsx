import { describe, expect, it, vi } from "vitest";
import { screen, waitFor, fireEvent, act } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
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
        triggerSource: "web",
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
    mockChatAPIs();

    await setupPage({
      context,
      path: "/talk/c0000000-0000-4000-a000-000000000001",
    });

    // Wait for the chat input to be ready
    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
    );

    // Type a message
    fireEvent.change(textarea, { target: { value: "Hello" } });

    // Press Enter to send
    const preventDefault = vi.fn();
    await act(() => {
      textarea.dispatchEvent(
        Object.assign(
          new KeyboardEvent("keydown", { key: "Enter", bubbles: true }),
          { preventDefault },
        ),
      );
    });

    // The URL should navigate to /chat/new-thread-id-123
    await waitFor(() => {
      expect(pathname()).toBe("/chat/new-thread-id-123");
    });
  }, 15_000);

  it("should navigate to /chat/:chatThreadId after completing onboarding and sending auto-intro", async () => {
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
            defaultAgentId: "d0000000-0000-4000-a000-000000000001",
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
      // Org name update
      http.put("*/api/zero/org", () => {
        return HttpResponse.json({
          id: "org_1",
          slug: "test-workspace",
          name: "Test Workspace",
        });
      }),
      // Model provider creation
      http.post("*/api/zero/model-providers", () => {
        return HttpResponse.json(
          {
            provider: {
              id: "a0000000-0000-4000-a000-000000000099",
              type: "vm0",
              framework: "claude-code",
              secretName: null,
              authMethod: null,
              secretNames: null,
              isDefault: true,
              selectedModel: null,
              createdAt: "2026-03-01T00:00:00Z",
              updatedAt: "2026-03-01T00:00:00Z",
            },
            created: true,
          },
          { status: 201 },
        );
      }),
      // Agent creation
      http.post("*/api/zero/agents", () => {
        onboardingComplete = true;
        return HttpResponse.json(
          {
            name: "zero",
            agentId: "d0000000-0000-4000-a000-000000000001",
            description: null,
            displayName: null,
            sound: null,
            avatarUrl: null,
            connectors: [],
            firewallPolicies: null,
          },
          { status: 201 },
        );
      }),
      // Instructions upload
      http.put("*/api/zero/agents/:name/instructions", () => {
        return HttpResponse.json({
          name: "zero",
          agentId: "d0000000-0000-4000-a000-000000000001",
          description: null,
          displayName: null,
          sound: null,
          avatarUrl: null,
          connectors: [],
          firewallPolicies: null,
        });
      }),
      // Default agent
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({
          agentId: "d0000000-0000-4000-a000-000000000001",
        });
      }),
      // Onboarding completion
      http.post("*/api/zero/onboarding/complete", () => {
        return HttpResponse.json({ ok: true });
      }),
    );

    // Mock chat APIs for the auto-intro message
    mockChatAPIs();

    await setupPage({ context, path: "/" });

    // Step 1: Workspace name
    await waitFor(() => {
      expect(screen.getByText(/Name your workspace/)).toBeInTheDocument();
    });

    // Fill name and advance
    const input = screen.getByPlaceholderText("e.g. Acme Corp");
    fireEvent.change(input, { target: { value: "Test Workspace" } });
    fireEvent.click(screen.getByText("Next"));

    // Step 2: Choose your tools → Next
    await waitFor(() => {
      expect(screen.getByText("Choose your tools")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Next"));

    // Step 3: Connect your apps → Next
    await waitFor(() => {
      expect(screen.getByText("Connect your apps")).toBeInTheDocument();
    });
    fireEvent.click(screen.getByText("Next"));

    // Step 4: Where to work
    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // Click "Continue in web" which triggers:
    // 1. completeZeroOnboarding$ (create agent, set default)
    // 2. navigate("/") → setupChatPage$ redirects to /talk/zero
    // 3. sendNewThreadMessage$(agentId, "Who are you and what can you do?")
    //    → POST /api/zero/chat/messages → navigates to /chat/:threadId
    const continueButton = screen.getByRole("button", {
      name: /Continue in web/,
    });
    fireEvent.click(continueButton);

    // The final URL should be /chat/new-thread-id-123 after the auto-intro
    // message creates a thread and navigates
    await waitFor(() => {
      expect(pathname()).toBe("/chat/new-thread-id-123");
    });
  }, 15_000);
});
