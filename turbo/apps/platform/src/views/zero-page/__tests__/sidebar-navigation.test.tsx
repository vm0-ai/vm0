import { describe, expect, it } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/core/contracts/chat-threads";
import { zeroTeamContract } from "@vm0/core/contracts/zero-team";
import { zeroAgentsByIdContract } from "@vm0/core/contracts/zero-agents";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";

const context = testContext();
const mockApi = createMockApi(context);

function mockSubagentAPIs() {
  // Stateful thread store — POST adds threads, GET returns them
  const threads: {
    id: string;
    title: string | null;
    agentId: string;
    createdAt: string;
    updatedAt: string;
    isRead: boolean;
    isArchived: boolean;
    running: boolean;
  }[] = [
    {
      id: "thread-sub-1",
      title: "Subagent thread",
      agentId: "subagent-compose-id",
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      isRead: false,
      isArchived: false,
      running: false,
    },
  ];

  setMockTeam([
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
  server.use(
    mockApi(zeroTeamContract.list, ({ respond }) => {
      return respond(200, [
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
    mockApi(zeroAgentsByIdContract.get, ({ params, respond }) => {
      if (params.id === "subagent-compose-id") {
        return respond(200, {
          agentId: "subagent-compose-id",
          ownerId: "test-user",
          displayName: "Helper Bot",
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
          modelProviderId: null,
          selectedModel: null,
        });
      }
      return respond(200, {
        agentId: "c0000000-0000-4000-a000-000000000001",
        ownerId: "test-user",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        permissionPolicies: null,
        customSkills: [],
        modelProviderId: null,
        selectedModel: null,
      });
    }),
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
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
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:01Z",
      });
    }),
    mockApi(chatThreadsContract.create, ({ body, respond }) => {
      const now = new Date().toISOString();
      const newThread = {
        id: "new-thread-id",
        title: body.title ?? null,
        agentId: body.agentId,
        createdAt: now,
        updatedAt: now,
        isRead: false,
        isArchived: false,
        running: false,
      };
      threads.unshift(newThread);
      return respond(201, {
        id: newThread.id,
        title: newThread.title,
        createdAt: newThread.createdAt,
      });
    }),
  );
}

describe("sidebar new chat navigation", () => {
  it("should create thread and navigate to /chat/:threadId when clicking new chat for default agent", async () => {
    mockSubagentAPIs();

    // Start on the default agent chat page — this synchronously sets currentChatAgentId$
    // so ChatThreadsSection doesn't remount between waitFor and click
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
      featureSwitches: { [FeatureSwitchKey.UnifyChatThreads]: true },
    });

    // Wait for thread list to load
    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Subagent thread")).toBeInTheDocument();
      return screen.getByLabelText("New chat");
    });

    click(newChatButton);

    // Verify navigation to /chat/:threadId
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-id");
    });
  });

  it("should create thread and navigate to /chat/:threadId when clicking new chat for a subagent", async () => {
    mockSubagentAPIs();

    detachedSetupPage({
      context,
      path: "/agents/subagent-compose-id/chat",
      featureSwitches: { [FeatureSwitchKey.UnifyChatThreads]: true },
    });

    // Wait for thread list to load — confirms currentChatAgentId$ has resolved
    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Subagent thread")).toBeInTheDocument();
      return screen.getByLabelText("New chat");
    });

    click(newChatButton);

    // Verify navigation to /chat/:threadId
    await waitFor(() => {
      expect(pathname()).toBe("/chats/new-thread-id");
    });
  });

  it("should disable button during thread creation", async () => {
    mockSubagentAPIs();
    // Override POST with deferred so we can control when the response arrives
    const createDeferred = createDeferredPromise<void>(context.signal);
    server.use(
      mockApi(chatThreadsContract.create, async ({ respond }) => {
        await createDeferred.promise;
        return respond(201, {
          id: "delayed-thread-id",
          title: null,
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    // Start on the default agent chat page — this synchronously sets currentChatAgentId$
    // so ChatThreadsSection doesn't remount between waitFor and click
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
      featureSwitches: { [FeatureSwitchKey.UnifyChatThreads]: true },
    });

    // Wait for thread list to load
    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Subagent thread")).toBeInTheDocument();
      return screen.getByLabelText("New chat");
    });

    click(newChatButton);

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
    mockSubagentAPIs();

    // Override list and detail endpoints to include the newly created thread.
    // fetchZeroSessionList$ is always called after navigation so the list must
    // include the new thread (title: null) for "New chat" to appear in the sidebar.
    server.use(
      mockApi(chatThreadsContract.list, ({ respond }) => {
        return respond(200, {
          threads: [
            {
              id: "new-thread-id",
              title: null,
              agentId: "c0000000-0000-4000-a000-000000000001",
              createdAt: "2026-03-10T00:00:00Z",
              updatedAt: "2026-03-10T00:00:00Z",
              isRead: false,
              isArchived: false,
              running: false,
            },
          ],
        });
      }),
      mockApi(chatThreadByIdContract.get, ({ respond }) => {
        return respond(200, {
          id: "new-thread-id",
          title: null,
          agentId: "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: "session-new-1",
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: "2026-03-10T00:00:00Z",
          updatedAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    // Start on the default agent chat page — this synchronously sets currentChatAgentId$
    // so ChatThreadsSection doesn't remount between waitFor and click
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
      featureSwitches: { [FeatureSwitchKey.UnifyChatThreads]: true },
    });

    // Wait for thread list to load (thread with null title appears as "New chat" span)
    const newChatButton = await waitFor(() => {
      expect(
        screen.getByText("New chat", { selector: "span" }),
      ).toBeInTheDocument();
      return screen.getByLabelText("New chat");
    });

    click(newChatButton);

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
