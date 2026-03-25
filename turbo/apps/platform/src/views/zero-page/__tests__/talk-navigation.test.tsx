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
    http.post("*/api/zero/chat-threads", () => {
      return HttpResponse.json(
        { id: "new-thread-id-123", title: "Hello" },
        { status: 201 },
      );
    }),
    http.post("*/api/zero/runs", () => {
      return HttpResponse.json({ id: "run-abc-123" }, { status: 201 });
    }),
    http.post("*/api/zero/chat-threads/:id/runs", () => {
      return new HttpResponse(null, { status: 204 });
    }),
    http.get("*/api/zero/runs/:id/telemetry/agent", () => {
      return HttpResponse.json({
        events: [],
        hasMore: false,
        framework: "claude-code",
      });
    }),
    // Return terminal status so polling loop stops immediately
    http.get("*/api/zero/logs/:id", () => {
      return HttpResponse.json({
        id: "run-abc-123",
        sessionId: "session-1",
        agentId: "zero",
        displayName: null,
        framework: "claude-code",
        modelProvider: null,
        triggerSource: "web",
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
  it("should navigate from /talk/:name to /chat/:sessionId after sending a message", async () => {
    mockChatAPIs();

    await setupPage({ context, path: "/talk/mock-compose-id" });

    // Wait for the chat input to be ready
    const textarea = await waitFor(
      () => screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement,
      { timeout: 5000 },
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
    await waitFor(
      () => {
        expect(pathname()).toBe("/chat/new-thread-id-123");
      },
      { timeout: 5000 },
    );
  }, 15_000);

  it("should navigate to /chat/:sessionId after completing onboarding and sending auto-intro", async () => {
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
            defaultAgentId: "new-compose-id",
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
      // Agent creation
      http.post("*/api/zero/agents", () => {
        onboardingComplete = true;
        return HttpResponse.json(
          {
            name: "zero",
            agentId: "new-compose-id",
          },
          { status: 201 },
        );
      }),
      // Instructions upload
      http.put("*/api/zero/agents/:name/instructions", () => {
        return HttpResponse.json({ success: true });
      }),
      // Default agent
      http.put("*/api/zero/default-agent", () => {
        return HttpResponse.json({ success: true });
      }),
    );

    // Mock chat APIs for the auto-intro message
    mockChatAPIs();

    await setupPage({ context, path: "/" });

    // Step 1: Wait for welcome screen
    await waitFor(
      () => {
        expect(
          screen.getByText(/Meet Zero, your new teammate/),
        ).toBeInTheDocument();
      },
      { timeout: 5000 },
    );

    // Click Next → step 3 (connectors)
    fireEvent.click(screen.getByRole("button", { name: "Next" }));

    await waitFor(() => {
      expect(screen.getByText("Add connector")).toBeInTheDocument();
    });

    // Click Next → step 4 (where to work)
    fireEvent.click(screen.getAllByRole("button", { name: "Next" })[0]!);

    await waitFor(() => {
      expect(
        screen.getByText(/Where would you like to work with/),
      ).toBeInTheDocument();
    });

    // Click "Chat with Zero" which triggers:
    // 1. completeZeroOnboarding$ (create agent, set default)
    // 2. navigate("/") → setupChatPage$ redirects to /talk/zero
    // 3. sendZeroChatMessage$("Who are you and what can you do?")
    //    → ensureChatThread() → navigates to /chat/:threadId
    const chatWithZeroButton = screen.getByRole("button", {
      name: /Chat with Zero/,
    });
    fireEvent.click(chatWithZeroButton);

    // The final URL should be /chat/new-thread-id-123 after the auto-intro
    // message creates a thread and navigates
    await waitFor(
      () => {
        expect(pathname()).toBe("/chat/new-thread-id-123");
      },
      { timeout: 10_000 },
    );
  }, 30_000);
});
