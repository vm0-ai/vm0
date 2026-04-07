import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { setupPage } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";

const context = testContext();

function mockSubagentAPIs() {
  // Stateful thread store — POST adds threads, GET returns them
  const threads: {
    id: string;
    title: string | null;
    agentId: string;
    createdAt: string;
    updatedAt: string;
  }[] = [
    {
      id: "thread-sub-1",
      title: "Subagent thread",
      agentId: "subagent-compose-id",
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    },
  ];

  server.use(
    http.get("*/api/zero/team", () => {
      return HttpResponse.json([
        {
          id: "c0000000-0000-4000-a000-000000000001",
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: "subagent-compose-id",
          displayName: "Helper Bot",
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_2",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    http.get("*/api/zero/chat-threads", () => {
      return HttpResponse.json({ threads });
    }),
    http.get("*/api/zero/chat-threads/:id", () => {
      return HttpResponse.json({
        id: "thread-sub-1",
        title: "Subagent thread",
        agentId: "subagent-compose-id",
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
        unsavedRuns: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
      });
    }),
    http.get("*/api/zero/agents/:id", ({ params }) => {
      const agents: Record<
        string,
        {
          agentId: string;
          displayName: string;
          ownerId: string;
          description: null;
          sound: null;
          avatarUrl: null;
          firewallPolicies: null;
        }
      > = {
        "c0000000-0000-4000-a000-000000000001": {
          agentId: "c0000000-0000-4000-a000-000000000001",
          ownerId: "test-user",
          displayName: "Zero",
          description: null,
          sound: null,
          avatarUrl: null,
          firewallPolicies: null,
        },
        "subagent-compose-id": {
          agentId: "subagent-compose-id",
          ownerId: "test-user",
          displayName: "Helper Bot",
          description: null,
          sound: null,
          avatarUrl: null,
          firewallPolicies: null,
        },
      };
      const agent = agents[params.id as string];
      if (!agent) {
        return HttpResponse.json({ error: "Not found" }, { status: 404 });
      }
      return HttpResponse.json(agent);
    }),
    http.post("*/api/zero/chat-threads", async ({ request }) => {
      const body = (await request.json()) as {
        agentId: string;
        title?: string;
      };
      const now = new Date().toISOString();
      const newThread = {
        id: "new-thread-id",
        title: body.title ?? null,
        agentId: body.agentId,
        createdAt: now,
        updatedAt: now,
      };
      threads.unshift(newThread);
      return HttpResponse.json(
        {
          id: newThread.id,
          title: newThread.title,
          createdAt: newThread.createdAt,
        },
        { status: 201 },
      );
    }),
  );
}

describe("sidebar new chat navigation", () => {
  it("should create thread and navigate to /chat/:threadId when clicking new chat for default agent", async () => {
    const user = userEvent.setup();
    mockSubagentAPIs();

    // Start on /team so the "new chat" button navigates away
    await setupPage({ context, path: "/agents" });

    // Wait for the sidebar to render with the new chat button
    const newChatButton = await waitFor(() => {
      return screen.getByLabelText("New chat with Zero");
    });

    await user.click(newChatButton);

    // Verify navigation to /chat/:threadId
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-id");
    });
  });

  it("should create thread and navigate to /chat/:threadId when clicking new chat for a subagent", async () => {
    const user = userEvent.setup();
    mockSubagentAPIs();

    await setupPage({ context, path: "/agents/subagent-compose-id/chat" });

    // Wait for the subagent chat to load — find the new chat button for the subagent
    const newChatButton = await waitFor(() => {
      return screen.getByLabelText("New chat with Helper Bot");
    });

    await user.click(newChatButton);

    // Verify navigation to /chat/:threadId
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-id");
    });
  });

  it("should disable button during thread creation", async () => {
    const user = userEvent.setup();
    mockSubagentAPIs();
    // Override POST with deferred so we can control when the response arrives
    const createDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      http.post("*/api/zero/chat-threads", async () => {
        await createDeferred.promise;
        return HttpResponse.json(
          {
            id: "delayed-thread-id",
            title: null,
            createdAt: "2026-03-10T00:00:00Z",
          },
          { status: 201 },
        );
      }),
    );

    await setupPage({ context, path: "/agents" });

    const newChatButton = await waitFor(() => {
      return screen.getByLabelText("New chat with Zero");
    });

    await user.click(newChatButton);

    // Button should be disabled while creating
    await waitFor(() => {
      expect(newChatButton).toBeDisabled();
    });

    // Release deferred so creation completes
    createDeferred.resolve();

    // After creation completes, button should be re-enabled
    await waitFor(() => {
      expect(pathname()).toBe("/chats/delayed-thread-id");
    });
  });

  it("should show new chat entry in sidebar and focus textarea after creating new chat", async () => {
    const user = userEvent.setup();
    mockSubagentAPIs();

    // Override list and detail endpoints to include the newly created thread.
    // fetchZeroSessionList$ is always called after navigation so the list must
    // include the new thread (title: null) for "New chat" to appear in the sidebar.
    server.use(
      http.get("*/api/zero/chat-threads", () => {
        return HttpResponse.json({
          threads: [
            {
              id: "new-thread-id",
              title: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T00:00:00Z",
              updatedAt: "2026-03-10T00:00:00Z",
            },
          ],
        });
      }),
      http.get("*/api/zero/chat-threads/:id", () => {
        return HttpResponse.json({
          id: "new-thread-id",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: "session-new-1",
          unsavedRuns: [],
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    await setupPage({ context, path: "/agents" });

    const newChatButton = await waitFor(() => {
      return screen.getByLabelText("New chat with Zero");
    });

    await user.click(newChatButton);

    // 1. Verify navigation (URL-based selection confirmation)
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-id");
    });

    // 2. Verify sidebar shows "New chat" entry (thread has title: null)
    await waitFor(() => {
      expect(
        screen.getByText("New chat", { selector: "span" }),
      ).toBeInTheDocument();
    });

    // 3. Verify textarea has focus (autoFocus triggers because chatMessages is empty)
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveFocus();
    });
  });
});
