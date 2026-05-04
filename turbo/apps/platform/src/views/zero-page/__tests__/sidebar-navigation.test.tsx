import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { server } from "../../../mocks/server.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { detachedSetupPage, click } from "../../../__tests__/page-helper.ts";
import { pathname } from "../../../signals/location.ts";
import { createDeferredPromise } from "../../../signals/utils.ts";
import { detachedNavigateTo$ } from "../../../signals/route.ts";
import { createNewChatThreadOptimistically$ } from "../../../signals/chat-page/optimistic-chat-thread-page.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";
import { createMockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";

const context = testContext();
const mockApi = createMockApi(context);

function mockSubagentAPIs() {
  // Stateful thread store — POST adds threads, GET returns them
  const createdThreadIds: string[] = [];
  const threads: {
    id: string;
    title: string | null;
    agent: { id: string; avatarUrl: string | null };
    createdAt: string;
    updatedAt: string;
    isRead: boolean;
    isArchived: boolean;
    running: boolean;
  }[] = [
    {
      id: "thread-sub-1",
      title: "Subagent thread",
      agent: { id: "subagent-compose-id", avatarUrl: null },
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
    mockApi(chatThreadByIdContract.get, ({ params, respond }) => {
      if (params.id !== "thread-sub-1") {
        const thread = threads.find((item) => {
          return item.id === params.id;
        });
        return respond(200, {
          id: params.id,
          title: thread?.title ?? null,
          agentId: thread?.agent.id ?? "c0000000-0000-4000-a000-000000000001",
          chatMessages: [],
          latestSessionId: null,
          activeRunIds: [],
          draftContent: null,
          draftAttachments: null,
          createdAt: thread?.createdAt ?? "2026-03-10T00:00:00Z",
          updatedAt: thread?.updatedAt ?? "2026-03-10T00:00:00Z",
        });
      }
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
      const id = body.clientThreadId ?? "new-thread-id";
      createdThreadIds.unshift(id);
      const newThread = {
        id,
        title: body.title ?? null,
        agent: { id: body.agentId, avatarUrl: null },
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

  return { createdThreadIds };
}

describe("sidebar new chat navigation", () => {
  it("should create thread and navigate to /chat/:threadId when clicking new chat for default agent", async () => {
    const { createdThreadIds } = mockSubagentAPIs();

    // Start on the default agent chat page — this synchronously sets currentChatAgentId$
    // so ChatThreadsSection doesn't remount between waitFor and click
    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    // Wait for thread list to load
    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Subagent thread")).toBeInTheDocument();
      return screen.getByLabelText(/^New chat/);
    });

    click(newChatButton);

    // Verify navigation to /chat/:threadId
    await waitFor(() => {
      expect(createdThreadIds).toHaveLength(1);
      expect(pathname()).toBe(`/chats/${createdThreadIds[0]!}`);
    });
  });

  it("should create thread and navigate to /chat/:threadId when clicking new chat for a subagent", async () => {
    const { createdThreadIds } = mockSubagentAPIs();

    detachedSetupPage({
      context,
      path: "/agents/subagent-compose-id/chat",
    });

    // Wait for thread list to load — confirms currentChatAgentId$ has resolved
    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Subagent thread")).toBeInTheDocument();
      return screen.getByLabelText(/^New chat/);
    });

    click(newChatButton);

    // Verify navigation to /chat/:threadId
    await waitFor(() => {
      expect(createdThreadIds).toHaveLength(1);
      expect(pathname()).toBe(`/chats/${createdThreadIds[0]!}`);
    });
  });

  it("should disable button during thread creation", async () => {
    mockSubagentAPIs();
    // Override POST with deferred so we can control when the response arrives
    const createDeferred = createDeferredPromise<void>(context.signal);
    let clientThreadId: string | null = null;
    server.use(
      mockApi(chatThreadsContract.create, async ({ body, respond }) => {
        clientThreadId = body.clientThreadId ?? null;
        await createDeferred.promise;
        return respond(201, {
          id: body.clientThreadId ?? "delayed-thread-id",
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
    });

    // Wait for thread list to load
    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Subagent thread")).toBeInTheDocument();
      return screen.getByLabelText(/^New chat/);
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
      expect(clientThreadId).not.toBeNull();
      expect(pathname()).toBe(`/chats/${clientThreadId}`);
    });
  });

  it("should show new chat entry in sidebar and focus textarea after creating new chat", async () => {
    mockSubagentAPIs();
    const createDeferred = createDeferredPromise<void>(context.signal);
    let createdThreadId: string | null = null;
    server.use(
      mockApi(chatThreadsContract.create, async ({ body, respond }) => {
        createdThreadId = body.clientThreadId ?? "created-thread-id";
        await createDeferred.promise;
        return respond(201, {
          id: createdThreadId,
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
    });

    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Subagent thread")).toBeInTheDocument();
      return screen.getByLabelText(/^New chat/);
    });

    click(newChatButton);
    await waitFor(() => {
      expect(createdThreadId).not.toBeNull();
    });
    const threadId = createdThreadId;
    if (!threadId) {
      throw new Error("Expected created thread id");
    }

    // 1. Verify navigation (URL-based selection confirmation)
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${threadId}`);
    });

    // 2. Verify sidebar row falls back to "New chat" for a null title.
    await waitFor(() => {
      const link = document.querySelector(`a[href="/chats/${threadId}"]`);
      expect(link).toBeInTheDocument();
      expect(within(link as HTMLElement).getByText("New chat")).toBeDefined();
    });

    // 3. Verify textarea has focus (autoFocus triggers because chatMessages is empty)
    await waitFor(() => {
      expect(screen.getByRole("textbox")).toHaveFocus();
    });

    createDeferred.resolve();
  });

  it("should reuse an existing optimistic new chat when creating again", async () => {
    mockSubagentAPIs();

    const createDeferred = createDeferredPromise<void>(context.signal);
    let createCount = 0;
    let clientThreadId: string | null = null;
    server.use(
      mockApi(chatThreadsContract.create, async ({ body, respond }) => {
        createCount++;
        clientThreadId = body.clientThreadId ?? null;
        await createDeferred.promise;
        return respond(201, {
          id: body.clientThreadId ?? "delayed-thread-id",
          title: null,
          createdAt: "2026-03-10T00:00:00Z",
        });
      }),
    );

    detachedSetupPage({
      context,
      path: "/agents/c0000000-0000-4000-a000-000000000001/chat",
    });

    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Subagent thread")).toBeInTheDocument();
      return screen.getByLabelText(/^New chat/);
    });

    click(newChatButton);

    await waitFor(() => {
      expect(createCount).toBe(1);
      expect(clientThreadId).not.toBeNull();
      expect(pathname()).toBe(`/chats/${clientThreadId}`);
    });

    await context.store.set(
      createNewChatThreadOptimistically$,
      "c0000000-0000-4000-a000-000000000001",
      "main",
      context.signal,
    );
    expect(createCount).toBe(1);
    expect(pathname()).toBe(`/chats/${clientThreadId}`);

    context.store.set(detachedNavigateTo$, "/agents/:agentId/chat", {
      pathParams: { agentId: "c0000000-0000-4000-a000-000000000001" },
    });
    await waitFor(() => {
      expect(pathname()).toBe(
        "/agents/c0000000-0000-4000-a000-000000000001/chat",
      );
    });

    await context.store.set(
      createNewChatThreadOptimistically$,
      "c0000000-0000-4000-a000-000000000001",
      "main",
      context.signal,
    );

    await waitFor(() => {
      expect(createCount).toBe(1);
      expect(pathname()).toBe(`/chats/${clientThreadId}`);
    });

    createDeferred.resolve();
  });
});
