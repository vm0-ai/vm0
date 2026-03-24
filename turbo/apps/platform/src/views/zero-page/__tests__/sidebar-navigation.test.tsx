import { describe, expect, it } from "vitest";
import { screen, waitFor, fireEvent } from "@testing-library/react";
import { http, HttpResponse, delay } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";

const context = testContext();

function mockSubagentAPIs() {
  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json({
        composes: [
          {
            id: "mock-compose-id",
            name: "zero",
            displayName: null,
            headVersionId: "version_1",
            updatedAt: "2024-01-01T00:00:00Z",
            isOwner: true,
          },
          {
            id: "subagent-compose-id",
            name: "helper",
            displayName: "Helper Bot",
            headVersionId: "version_2",
            updatedAt: "2024-01-01T00:00:00Z",
            isOwner: true,
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({
        threads: [
          {
            id: "thread-sub-1",
            title: "Subagent thread",
            preview: "Hello from subagent",
            agentComposeId: "subagent-compose-id",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
          },
        ],
      });
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "thread-sub-1",
        title: "Subagent thread",
        agentComposeId: "subagent-compose-id",
        chatMessages: [
          {
            role: "user",
            content: "Hello from subagent",
            createdAt: "2026-03-10T00:00:00Z",
          },
          {
            role: "assistant",
            content: "Hi, I am Helper Bot!",
            createdAt: "2026-03-10T00:00:01Z",
          },
        ],
        latestSessionId: "session-sub-1",
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
      });
    }),
    http.post("*/api/zero/chat-threads", () => {
      return HttpResponse.json({
        id: "new-thread-id",
        title: null,
      });
    }),
  );
}

describe("sidebar new chat navigation", () => {
  it("should create thread and navigate to /chat/:threadId when clicking new chat for default agent", async () => {
    mockSubagentAPIs();

    // Start on /team so the "new chat" button navigates away
    await setupPage({ context, path: "/team" });

    // Wait for the sidebar to render with the new chat button
    const newChatButton = await waitFor(
      () => {
        return screen.getByLabelText("New chat with Zero");
      },
      { timeout: 5000 },
    );

    fireEvent.click(newChatButton);

    // Verify navigation to /chat/:threadId
    await waitFor(() => {
      expect(pathname()).toBe("/chat/new-thread-id");
    });
  }, 15_000);

  it("should create thread and navigate to /chat/:threadId when clicking new chat for a subagent", async () => {
    mockSubagentAPIs();

    await setupPage({ context, path: "/talk/helper" });

    // Wait for the subagent chat to load — find the new chat button for the subagent
    const newChatButton = await waitFor(
      () => {
        return screen.getByLabelText("New chat with Helper Bot");
      },
      { timeout: 5000 },
    );

    fireEvent.click(newChatButton);

    // Verify navigation to /chat/:threadId
    await waitFor(() => {
      expect(pathname()).toBe("/chat/new-thread-id");
    });
  }, 15_000);

  it("should disable button during thread creation", async () => {
    mockSubagentAPIs();
    // Override POST to add a delay
    server.use(
      http.post("*/api/zero/chat-threads", async () => {
        await delay(500);
        return HttpResponse.json({
          id: "delayed-thread-id",
          title: null,
        });
      }),
    );

    await setupPage({ context, path: "/team" });

    const newChatButton = await waitFor(
      () => {
        return screen.getByLabelText("New chat with Zero");
      },
      { timeout: 5000 },
    );

    fireEvent.click(newChatButton);

    // Button should be disabled while creating
    await waitFor(() => {
      expect(newChatButton).toBeDisabled();
    });

    // After creation completes, button should be re-enabled
    await waitFor(
      () => {
        expect(pathname()).toBe("/chat/delayed-thread-id");
      },
      { timeout: 5000 },
    );
  }, 15_000);

  it("should handle API failure gracefully", async () => {
    mockSubagentAPIs();
    // Override POST to return error
    server.use(
      http.post("*/api/zero/chat-threads", () => {
        return new HttpResponse(null, { status: 500 });
      }),
    );

    await setupPage({ context, path: "/team" });

    const initialPath = pathname();

    const newChatButton = await waitFor(
      () => {
        return screen.getByLabelText("New chat with Zero");
      },
      { timeout: 5000 },
    );

    fireEvent.click(newChatButton);

    // Wait for the request to complete (button should become enabled again)
    await waitFor(() => {
      expect(newChatButton).not.toBeDisabled();
    });

    // Should not have navigated
    expect(pathname()).toBe(initialPath);
  }, 15_000);
});
