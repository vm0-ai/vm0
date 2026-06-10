import { screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockScheduleResponse } from "../../../mocks/handlers/api-schedules.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { splitChatThreadListResponse } from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
const EXISTING_THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const INCIDENT_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const SCHEDULED_THREAD_ID = "b0000000-0000-4000-a000-000000000003";
const ARCHIVED_THREAD_ID = "b0000000-0000-4000-a000-000000000004";

type SidebarThread = Parameters<typeof splitChatThreadListResponse>[0][number];

function prepareDefaultAgent(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
}

function prepareAgentTeam(): void {
  context.mocks.data.team([
    {
      id: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: RESEARCH_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Research Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_2",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: SUPPORT_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Support Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      visibility: "public",
      headVersionId: "version_3",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const displayNameById: Record<string, string> = {
      [AGENT_ID]: "Zero",
      [RESEARCH_AGENT_ID]: "Research Agent",
      [SUPPORT_AGENT_ID]: "Support Agent",
    };
    return respond(200, {
      agentId: params.id,
      ownerId: "test-user-123",
      description: null,
      displayName: displayNameById[params.id] ?? null,
      sound: null,
      avatarUrl: null,
      customSkills: [],
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
    });
  });
}

function createThread(
  id: string,
  title: string,
  overrides: Partial<SidebarThread> = {},
): SidebarThread {
  return {
    id,
    title,
    agent: { id: AGENT_ID, avatarUrl: null },
    createdAt: "2026-03-10T00:00:00Z",
    updatedAt: "2026-03-10T00:00:00Z",
    isRead: true,
    running: false,
    pinnedAt: null,
    ...overrides,
  };
}

function menuItemByText(text: string): HTMLElement {
  const item = queryAllByRoleFast("menuitem").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function buttonByText(
  text: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function sidebar(): HTMLElement {
  return screen.getByRole("navigation", { name: "Sidebar" });
}

function threadRowByTitle(title: string): HTMLElement {
  const link = queryAllByRoleFast("link", sidebar()).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === title;
  });
  if (!link) {
    throw new Error(`${title} thread link not found`);
  }
  const row = link.parentElement;
  if (!row) {
    throw new Error(`${title} thread row not found`);
  }
  return row;
}

function openThreadMenu(title: string): void {
  click(
    within(threadRowByTitle(title)).getByTestId("chat-thread-menu-trigger"),
  );
}

function mockSidebarThreadStory(
  firstPageThreads: SidebarThread[],
  extraThreads: SidebarThread[] = [],
): {
  threads: SidebarThread[];
} {
  let threads = [...firstPageThreads];

  context.mocks.api(chatThreadsContract.list, ({ query, respond }) => {
    if (query.cursor === "next-page") {
      return respond(200, {
        pinned: [],
        threads: extraThreads,
        hasMore: false,
        nextCursor: null,
        totalCount: threads.length + extraThreads.length,
      });
    }
    return respond(200, {
      ...splitChatThreadListResponse(threads),
      hasMore: extraThreads.length > 0,
      nextCursor: extraThreads.length > 0 ? "next-page" : null,
      totalCount: threads.length + extraThreads.length,
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    const thread = [...threads, ...extraThreads].find((candidate) => {
      return candidate.id === params.id;
    });
    return respond(200, {
      id: params.id,
      title: thread?.title ?? null,
      agentId: thread?.agent.id ?? AGENT_ID,
      latestSessionId: null,
      activeRunIds: [],
      draftContent: null,
      draftAttachments: null,
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(chatThreadPinContract.pin, ({ params, respond }) => {
    threads = threads.map((thread) => {
      return thread.id === params.id
        ? { ...thread, pinnedAt: "2026-03-10T12:00:00Z" }
        : thread;
    });
    return respond(204);
  });
  context.mocks.api(chatThreadUnpinContract.unpin, ({ params, respond }) => {
    threads = threads.map((thread) => {
      return thread.id === params.id ? { ...thread, pinnedAt: null } : thread;
    });
    return respond(204);
  });
  context.mocks.api(
    chatThreadRenameContract.rename,
    ({ params, body, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id
          ? {
              ...thread,
              title: body.title,
              renamedAt: "2026-03-10T12:01:00Z",
            }
          : thread;
      });
      return respond(204);
    },
  );
  context.mocks.api(chatThreadByIdContract.delete, ({ params, respond }) => {
    threads = threads.filter((thread) => {
      return thread.id !== params.id;
    });
    return respond(204);
  });

  return { threads };
}

describe("zero sidebar", () => {
  it("keeps known threads visible while creating a new chat", async () => {
    prepareDefaultAgent();
    const createDeferred = context.mocks.deferred<void>();

    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(
        200,
        splitChatThreadListResponse([
          {
            id: EXISTING_THREAD_ID,
            title: "Existing conversation",
            agent: { id: AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: true,
            running: false,
          },
        ]),
      );
    });
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      await createDeferred.promise;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title:
          params.id === EXISTING_THREAD_ID ? "Existing conversation" : null,
        agentId: AGENT_ID,
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const newChatButton = await waitFor(() => {
      expect(screen.getByText("Existing conversation")).toBeInTheDocument();
      return screen.getByLabelText("New chat with Zero");
    });

    click(newChatButton);

    await waitFor(() => {
      const sidebar = screen.getByRole("navigation", { name: "Sidebar" });
      expect(
        within(sidebar).getByText("Existing conversation"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("New chat")).toBeInTheDocument();
      expect(
        sidebar.querySelectorAll('[data-testid="sidebar-skeleton"]'),
      ).toHaveLength(0);
    });

    createDeferred.resolve();
  });

  it("pins and unpins a chat thread from the sidebar menu", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatThreadRename]: true },
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Pin chat"));

    await waitFor(() => {
      expect(
        within(threadRowByTitle("Release plan")).getByTestId(
          "chat-thread-pinned-indicator",
        ),
      ).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Unpin chat"));

    await waitFor(() => {
      expect(
        within(threadRowByTitle("Release plan")).queryByTestId(
          "chat-thread-pinned-indicator",
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("renames a chat thread from the sidebar menu", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);

    detachedSetupPage({
      context,
      featureSwitches: { [FeatureSwitchKey.ChatThreadRename]: true },
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Rename chat"));

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    await fill(
      within(dialog).getByPlaceholderText("Chat title"),
      "Launch plan",
    );
    click(buttonByText("Rename", dialog));

    await waitFor(() => {
      expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
      expect(
        within(sidebar()).queryByText("Release plan"),
      ).not.toBeInTheDocument();
    });
  });

  it("loads more sidebar chats and confirms deleting a scheduled chat", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(SCHEDULED_THREAD_ID, "Scheduled launch", {
          scheduleCount: 2,
        }),
      ],
      [createThread(ARCHIVED_THREAD_ID, "Archived context")],
    );
    context.mocks.data.schedules([
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000401",
        name: "launch-cadence",
        chatThreadId: SCHEDULED_THREAD_ID,
        description: "Launch cadence",
        prompt: "Post the launch cadence",
      }),
      createMockScheduleResponse({
        id: "f0000001-0000-4000-a000-000000000402",
        name: "release-risk-review",
        chatThreadId: SCHEDULED_THREAD_ID,
        description: "Release risk review",
        prompt: "Review release risks",
      }),
    ]);

    detachedSetupPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Scheduled launch"),
      ).toBeInTheDocument();
    });

    click(screen.getByTestId("sidebar-chat-threads-load-more"));

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Archived context"),
      ).toBeInTheDocument();
    });

    openThreadMenu("Scheduled launch");
    click(menuItemByText("Delete chat"));

    const dialog = await screen.findByRole("dialog", {
      name: "Delete chat and schedules?",
    });
    expect(within(dialog).getByText(/2 linked schedules/u)).toBeInTheDocument();
    expect(within(dialog).getByText("Launch cadence")).toBeInTheDocument();
    expect(within(dialog).getByText("Release risk review")).toBeInTheDocument();

    click(buttonByText("Delete chat and schedules", dialog));

    await waitFor(() => {
      expect(
        within(sidebar()).queryByText("Scheduled launch"),
      ).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });
  });

  it("pins an agent from the conversation picker and starts that agent chat", async () => {
    prepareAgentTeam();
    const createDeferred = context.mocks.deferred<void>();

    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      await createDeferred.promise;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title: null,
        agentId: RESEARCH_AGENT_ID,
        latestSessionId: null,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const sidebar = await waitFor(() => {
      return screen.getByRole("navigation", { name: "Sidebar" });
    });
    click(within(sidebar).getByLabelText("Open a conversation"));

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();

    await fill(
      within(dialog).getByPlaceholderText("Search agents..."),
      "support",
    );

    await waitFor(() => {
      expect(
        within(dialog).queryByText("Research Agent"),
      ).not.toBeInTheDocument();
      expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
    });

    click(within(dialog).getByLabelText("Clear search"));

    await waitFor(() => {
      expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    });

    click(within(dialog).getAllByLabelText("Pin to sidebar")[0]!);

    await waitFor(() => {
      expect(
        within(dialog).getByLabelText("Unpin Research Agent"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("Research Agent")).toBeInTheDocument();
    });

    const researchAgentButton = queryAllByRoleFast("button", dialog).find(
      (element) => {
        return element.textContent?.trim() === "Research Agent";
      },
    );
    if (!researchAgentButton) {
      throw new Error("Research Agent button not found");
    }
    click(researchAgentButton);

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Talk to" }),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar).getByText("Chats with Research Agent"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("New chat")).toBeInTheDocument();
    });

    createDeferred.resolve();
  });

  it("opens settings from the account menu and changes debug capture", async () => {
    prepareDefaultAgent();
    context.mocks.data.userPreferences({
      captureNetworkBodiesRemaining: 0,
    });
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      user: {
        id: "test-user-123",
        fullName: "Alex Rivera",
        email: "alex.rivera@example.test",
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("New chat with Zero")).toBeInTheDocument();
    });
    const accountName = await screen.findByText("Alex Rivera");
    const accountButton = accountName.closest("button");
    if (!accountButton) {
      throw new Error("Account menu trigger not found");
    }

    click(accountButton);

    const menu = await screen.findByRole("menu");
    expect(within(menu).getByText("Alex Rivera")).toBeInTheDocument();
    expect(
      within(menu).getByText("alex.rivera@example.test"),
    ).toBeInTheDocument();

    click(within(menu).getByText("Settings"));

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Settings" }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Preference" }),
      ).toBeInTheDocument();
    });

    click(buttonByText("Debug"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Debug" }),
      ).toBeInTheDocument();
      expect(screen.getByText("Capture network bodies")).toBeInTheDocument();
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(
        screen.getByText("Enabled for the next 3 runs"),
      ).toBeInTheDocument();
    });

    click(screen.getByRole("switch"));

    await waitFor(() => {
      expect(screen.getByText("Disabled")).toBeInTheDocument();
    });
  });
});
