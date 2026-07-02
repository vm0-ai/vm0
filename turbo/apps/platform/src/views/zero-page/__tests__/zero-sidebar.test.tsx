import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import { automationsMainContract } from "@vm0/api-contracts/contracts/automations";

import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { createMockAutomationView } from "../../../mocks/handlers/automations-store.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  PLACEHOLDER,
  splitChatThreadListResponse,
} from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
const EXISTING_THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const INCIDENT_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const AUTOMATION_THREAD_ID = "b0000000-0000-4000-a000-000000000003";
const ARCHIVED_THREAD_ID = "b0000000-0000-4000-a000-000000000004";
const RESEARCH_THREAD_ID = "b0000000-0000-4000-a000-000000000005";

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
    running: false,
    pinnedAt: null,
    ...overrides,
  };
}

function menuItemByText(text: string): HTMLElement {
  const item = queryMenuItemByText(text);
  if (!item) {
    throw new Error(`${text} menu item not found`);
  }
  return item;
}

function queryMenuItemByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("menuitem").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
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
  const link = threadLinkByTitle(title);
  const row = link.parentElement;
  if (!row) {
    throw new Error(`${title} thread row not found`);
  }
  return row;
}

function threadLinkByTitle(title: string): HTMLElement {
  const link = queryAllByRoleFast("link", sidebar()).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === title;
  });
  if (!link) {
    throw new Error(`${title} thread link not found`);
  }
  return link;
}

function visibleThreadTitles(expectedTitles: readonly string[]): string[] {
  const expected = new Set(expectedTitles);
  return queryAllByRoleFast("link", sidebar()).flatMap((candidate) => {
    const title = candidate.textContent?.replace(/\s+/g, " ").trim();
    return title && expected.has(title) ? [title] : [];
  });
}

function agentRowByName(container: HTMLElement, name: string): HTMLElement {
  const text = within(container).getByText(name);
  const row = text.closest(".group");
  if (!(row instanceof HTMLElement)) {
    throw new Error(`${name} agent row not found`);
  }
  return row;
}

function openAgentRowMenu(container: HTMLElement, name: string): void {
  click(
    within(agentRowByName(container, name)).getByLabelText("Open agent menu"),
  );
}

function openThreadMenu(title: string): void {
  click(
    within(threadRowByTitle(title)).getByTestId("chat-thread-menu-trigger"),
  );
}

function openChatListMenu(): void {
  click(within(sidebar()).getByLabelText("Open chat list menu"));
}

function mockSidebarThreadStory(
  firstPageThreads: SidebarThread[],
  extraThreads: SidebarThread[] = [],
  options: {
    readonly detailTitles?: Readonly<Record<string, string | null>>;
  } = {},
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
      });
    }
    return respond(200, {
      ...splitChatThreadListResponse(threads),
      hasMore: extraThreads.length > 0,
      nextCursor: extraThreads.length > 0 ? "next-page" : null,
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    const thread = [...threads, ...extraThreads].find((candidate) => {
      return candidate.id === params.id;
    });
    const detailTitle = Object.hasOwn(options.detailTitles ?? {}, params.id)
      ? options.detailTitles?.[params.id]
      : thread?.title;
    return respond(200, {
      id: params.id,
      title: detailTitle ?? null,
      agentId: thread?.agent.id ?? AGENT_ID,
      activeRunIds: [],
      draftContent: null,
      draftAttachments: null,
      createdAt: "2026-03-10T00:00:00Z",
      updatedAt: "2026-03-10T00:00:00Z",
      lastMessageAt: thread?.updatedAt ?? "2026-03-10T00:00:00Z",
      pinnedAt: thread?.pinnedAt ?? null,
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
      return screen.getByLabelText("Open chat list menu");
    });

    click(newChatButton);
    click(menuItemByText("New chat"));

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

  it("preserves server thread order while creating an optimistic new chat", async () => {
    prepareDefaultAgent();
    const createDeferred = context.mocks.deferred<void>();
    const serverOrderedThreads = [
      {
        id: EXISTING_THREAD_ID,
        title: "A server first",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        running: false,
        pinnedAt: null,
      },
      {
        id: INCIDENT_THREAD_ID,
        title: "B server second",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-11T00:00:00Z",
        running: false,
        pinnedAt: null,
      },
      {
        id: AUTOMATION_THREAD_ID,
        title: "C server third",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-12T00:00:00Z",
        running: false,
        pinnedAt: null,
      },
    ];

    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse(serverOrderedThreads));
    });
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      await createDeferred.promise;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-12T12:00:00Z",
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      const thread = serverOrderedThreads.find((candidate) => {
        return candidate.id === params.id;
      });
      return respond(200, {
        id: params.id,
        title: thread?.title ?? null,
        agentId: AGENT_ID,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: thread?.createdAt ?? "2026-03-12T12:00:00Z",
        updatedAt: thread?.updatedAt ?? "2026-03-12T12:00:00Z",
      });
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const newChatButton = await waitFor(() => {
      expect(
        visibleThreadTitles([
          "A server first",
          "B server second",
          "C server third",
        ]),
      ).toStrictEqual(["A server first", "B server second", "C server third"]);
      return screen.getByLabelText("Open chat list menu");
    });

    click(newChatButton);
    click(menuItemByText("New chat"));

    await waitFor(() => {
      expect(
        visibleThreadTitles([
          "New chat",
          "A server first",
          "B server second",
          "C server third",
        ]),
      ).toStrictEqual([
        "New chat",
        "A server first",
        "B server second",
        "C server third",
      ]);
    });

    createDeferred.resolve();
  });

  it("closes the artifact sidebar when creating a new main chat", async () => {
    prepareDefaultAgent();
    const artifactUrl = encodeURIComponent(
      "https://cdn.vm7.io/artifacts/test/archive.zip",
    );

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
            running: false,
          },
        ]),
      );
    });
    context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: [] });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      return respond(200, {
        id: params.id,
        title:
          params.id === EXISTING_THREAD_ID ? "Existing conversation" : null,
        agentId: AGENT_ID,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}?artifact=${artifactUrl}`,
    });

    const newChatButton = await waitFor(() => {
      expect(screen.getByTestId("artifact-sidebar")).toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Existing conversation"),
      ).toBeInTheDocument();
      const button = screen.getByLabelText("Open chat list menu");
      expect(button).not.toBeDisabled();
      return button;
    });

    click(newChatButton);
    click(menuItemByText("New chat"));

    await waitFor(() => {
      expect(screen.queryByTestId("artifact-sidebar")).not.toBeInTheDocument();
      expect(window.location.search).not.toContain("artifact=");
    });
  });

  it("requests unread chat threads and keeps the current chat at the front of the unpinned section", async () => {
    prepareDefaultAgent();
    const pinnedUnreadThread = createThread(
      AUTOMATION_THREAD_ID,
      "Pinned incident",
      {
        pinnedAt: "2026-03-10T12:00:00Z",
      },
    );
    const currentThread = createThread(EXISTING_THREAD_ID, "Release plan");
    const unreadThread = createThread(INCIDENT_THREAD_ID, "Incident notes");
    const archivedThread = createThread(ARCHIVED_THREAD_ID, "Archived context");
    const listQueries: unknown[] = [];

    context.mocks.api(chatThreadsContract.list, ({ query, respond }) => {
      listQueries.push(query);
      if (query.filter === "unread") {
        return respond(
          200,
          splitChatThreadListResponse([pinnedUnreadThread, unreadThread]),
        );
      }
      return respond(
        200,
        splitChatThreadListResponse([
          pinnedUnreadThread,
          currentThread,
          unreadThread,
          archivedThread,
        ]),
      );
    });
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      const thread = [
        pinnedUnreadThread,
        currentThread,
        unreadThread,
        archivedThread,
      ].find((candidate) => {
        return candidate.id === params.id;
      });
      return respond(200, {
        id: params.id,
        title: thread?.title ?? null,
        agentId: thread?.agent.id ?? AGENT_ID,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        lastMessageAt: thread?.updatedAt ?? "2026-03-10T00:00:00Z",
        pinnedAt: thread?.pinnedAt ?? null,
      });
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, {
        unreads: [
          {
            threadId: AUTOMATION_THREAD_ID,
            unreadAt: "2026-03-10T00:04:00Z",
          },
          { threadId: INCIDENT_THREAD_ID, unreadAt: "2026-03-10T00:05:00Z" },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.AgentUnreadIndicators]: true },
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Archived context"),
      ).toBeInTheDocument();
    });

    openChatListMenu();
    click(screen.getByRole("switch", { name: "Unread" }));
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => {
      expect(listQueries).toContainEqual(
        expect.objectContaining({ filter: "unread" }),
      );
      expect(
        visibleThreadTitles([
          "Pinned incident",
          "Release plan",
          "Incident notes",
        ]),
      ).toStrictEqual(["Pinned incident", "Release plan", "Incident notes"]);
      expect(
        within(sidebar()).queryByText("Archived context"),
      ).not.toBeInTheDocument();
    });
  });

  it("hides the unread chat filter when unread indicators are disabled", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, { unreads: [] });
    });

    detachedSetupPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });

    openChatListMenu();

    expect(screen.queryByRole("switch", { name: "Unread" })).toBeNull();
  });

  it("keeps a missing pinned current chat at the front of the pinned section", async () => {
    prepareDefaultAgent();
    const pinnedCurrentThread = createThread(
      EXISTING_THREAD_ID,
      "Release plan",
      {
        pinnedAt: "2026-03-10T12:00:00Z",
      },
    );
    const pinnedThread = createThread(AUTOMATION_THREAD_ID, "Pinned incident", {
      pinnedAt: "2026-03-10T11:00:00Z",
    });
    const unpinnedThread = createThread(INCIDENT_THREAD_ID, "Incident notes");

    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(
        200,
        splitChatThreadListResponse([pinnedThread, unpinnedThread]),
      );
    });
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      const thread = [pinnedCurrentThread, pinnedThread, unpinnedThread].find(
        (candidate) => {
          return candidate.id === params.id;
        },
      );
      return respond(200, {
        id: params.id,
        title: thread?.title ?? null,
        agentId: thread?.agent.id ?? AGENT_ID,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        lastMessageAt: thread?.updatedAt ?? "2026-03-10T00:00:00Z",
        pinnedAt: thread?.pinnedAt ?? null,
      });
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, { unreads: [] });
    });

    detachedSetupPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

    await waitFor(() => {
      expect(
        visibleThreadTitles([
          "Release plan",
          "Pinned incident",
          "Incident notes",
        ]),
      ).toStrictEqual(["Release plan", "Pinned incident", "Incident notes"]);
    });
  });

  it("clears a thread unread marker optimistically before mark-read resolves", async () => {
    prepareDefaultAgent();
    const markReadDeferred = context.mocks.deferred<void>();
    let markReadCalls = 0;
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, {
        unreads: [
          { threadId: INCIDENT_THREAD_ID, unreadAt: "2026-03-10T00:05:00Z" },
        ],
      });
    });
    context.mocks.api(
      chatThreadMessagesContract.list,
      ({ params, query, respond }) => {
        if (query.sinceId || query.beforeId) {
          return respond(200, { messages: [] });
        }
        return respond(200, {
          messages:
            params.threadId === INCIDENT_THREAD_ID
              ? [
                  {
                    id: "incident-message-1",
                    role: "assistant",
                    content: "Incident update",
                    createdAt: "2026-03-10T00:05:00Z",
                  },
                ]
              : [],
          hasHistoryBefore: false,
        });
      },
    );
    context.mocks.api(
      chatThreadMarkReadContract.markRead,
      async ({ respond }) => {
        markReadCalls += 1;
        await markReadDeferred.promise;
        return respond(200, {
          lastReadMessageId: "incident-message-1",
          unreads: [],
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${INCIDENT_THREAD_ID}` });

    await waitFor(() => {
      expect(markReadCalls).toBe(1);
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });

    click(threadLinkByTitle("Release plan"));

    await waitFor(() => {
      expect(
        within(threadRowByTitle("Incident notes")).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
    });

    markReadDeferred.resolve();
  });

  it("pins and unpins a chat thread from the sidebar menu", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
      createThread(AUTOMATION_THREAD_ID, "Running analysis", { running: true }),
      createThread(ARCHIVED_THREAD_ID, "Draft brief"),
    ]);
    context.mocks.api(chatThreadsContract.drafts, ({ respond }) => {
      return respond(200, { draftThreadIds: [ARCHIVED_THREAD_ID] });
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, {
        unreads: [
          { threadId: INCIDENT_THREAD_ID, unreadAt: "2026-03-10T00:05:00Z" },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}?sidebar=detached-thread`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
      expect(
        within(threadRowByTitle("Release plan")).getByTestId(
          "chat-thread-list-pane-icon-main",
        ),
      ).toBeInTheDocument();
      expect(
        within(threadRowByTitle("Incident notes")).getByLabelText("Unread"),
      ).toBeInTheDocument();
      expect(
        within(threadRowByTitle("Running analysis")).getByLabelText("Running"),
      ).toBeInTheDocument();
      expect(
        within(threadRowByTitle("Draft brief")).getByLabelText("Draft"),
      ).toBeInTheDocument();
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

    click(
      within(threadRowByTitle("Release plan")).getByTestId(
        "chat-thread-pinned-indicator",
      ),
    );
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
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(INCIDENT_THREAD_ID, "Incident notes"),
      ],
      [],
      {
        detailTitles: {
          [EXISTING_THREAD_ID]: "Thread data release plan",
        },
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Rename chat"));

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    const titleInput = within(dialog).getByPlaceholderText("Chat title");
    expect(titleInput).toHaveValue("Thread data release plan");

    await fill(titleInput, "Launch plan");
    const renameForm = titleInput.closest("form");
    expect(renameForm).not.toBeNull();
    fireEvent.submit(renameForm!);

    await waitFor(() => {
      expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
      expect(
        within(sidebar()).queryByText("Release plan"),
      ).not.toBeInTheDocument();
    });
  });

  it("does not prefill sidebar rename from the list title", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });

    openThreadMenu("Incident notes");
    click(menuItemByText("Rename chat"));

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue("");
  });

  it("renames a chat thread by double-clicking from the sidebar", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(INCIDENT_THREAD_ID, "Incident notes"),
      ],
      [],
      {
        detailTitles: {
          [EXISTING_THREAD_ID]: "Thread data release plan",
        },
      },
    );

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });

    fireEvent.doubleClick(threadLinkByTitle("Release plan"));

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    const titleInput = within(dialog).getByPlaceholderText("Chat title");
    expect(titleInput).toHaveValue("Thread data release plan");

    await fill(titleInput, "Launch plan");
    click(buttonByText("Rename", dialog));

    await waitFor(() => {
      expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
      expect(
        within(sidebar()).queryByText("Release plan"),
      ).not.toBeInTheDocument();
    });
  });

  it("loads more sidebar chats and confirms deleting a chat with automations", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
      ],
      [createThread(ARCHIVED_THREAD_ID, "Archived context")],
    );
    context.mocks.data.automations([
      createMockAutomationView({
        id: "f0000001-0000-4000-a000-000000000401",
        name: "launch-cadence",
        chatThreadId: AUTOMATION_THREAD_ID,
        description: "Launch cadence",
        prompt: "Post the launch cadence",
      }),
      createMockAutomationView({
        id: "f0000001-0000-4000-a000-000000000402",
        name: "release-risk-review",
        chatThreadId: AUTOMATION_THREAD_ID,
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
      name: "Delete chat and automations?",
    });
    expect(
      within(dialog).getByText(/2 linked automations/u),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Launch cadence")).toBeInTheDocument();
    expect(within(dialog).getByText("Release risk review")).toBeInTheDocument();

    click(buttonByText("Cancel", dialog));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: "Delete chat and automations?",
        }),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Scheduled launch"),
      ).toBeInTheDocument();
    });

    openThreadMenu("Scheduled launch");
    click(menuItemByText("Delete chat"));

    const confirmDialog = await screen.findByRole("dialog", {
      name: "Delete chat and automations?",
    });
    click(buttonByText("Delete chat and automations", confirmDialog));

    await waitFor(() => {
      expect(
        within(sidebar()).queryByText("Scheduled launch"),
      ).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });
  });

  it("skips the automations check when deleting a chat with workflow automation enabled", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
    ]);

    // Never resolves: if the delete flow still queried automations, the
    // dialog would be stuck showing the "checking" state forever.
    const automationsRequested = context.mocks.deferred<void>();
    context.mocks.api(automationsMainContract.list, async ({ respond }) => {
      await automationsRequested.promise;
      return respond(200, { automations: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.WorkflowAutomation]: true },
    });

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Scheduled launch"),
      ).toBeInTheDocument();
    });

    openThreadMenu("Scheduled launch");
    click(menuItemByText("Delete chat"));

    const dialog = await screen.findByRole("dialog", {
      name: "Delete chat?",
    });
    expect(
      screen.queryByTestId("delete-chat-thread-checking"),
    ).not.toBeInTheDocument();

    click(buttonByText("Delete", dialog));

    await waitFor(() => {
      expect(
        within(sidebar()).queryByText("Scheduled launch"),
      ).not.toBeInTheDocument();
    });
  });

  it("cancels and confirms deleting a regular chat from the sidebar", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);

    detachedSetupPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Delete chat"));

    const dialog = await screen.findByRole("dialog", {
      name: "Delete chat?",
    });
    expect(
      within(dialog).getByText(
        "This will permanently delete this chat. Any task currently running in this chat will be stopped immediately. This action cannot be undone.",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Cancel", dialog));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });

    openThreadMenu("Release plan");
    click(menuItemByText("Delete chat"));

    const confirmDialog = await screen.findByRole("dialog", {
      name: "Delete chat?",
    });
    click(buttonByText("Delete", confirmDialog));

    await waitFor(() => {
      expect(
        within(sidebar()).queryByText("Release plan"),
      ).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    });
  });

  it("pins an agent from the conversation picker and opens that agent chat", async () => {
    prepareAgentTeam();
    let createRequests = 0;

    context.mocks.api(chatThreadsContract.list, ({ query, respond }) => {
      const threads =
        query.agentId === RESEARCH_AGENT_ID
          ? [
              createThread(RESEARCH_THREAD_ID, "Research kickoff", {
                agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
              }),
            ]
          : [];
      return respond(200, splitChatThreadListResponse(threads));
    });
    context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
      createRequests += 1;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
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

    await fill(within(dialog).getByPlaceholderText("Search agents..."), "ops");

    await waitFor(() => {
      expect(within(dialog).getByText("No agents found")).toBeInTheDocument();
      expect(
        within(dialog).queryByText("Support Agent"),
      ).not.toBeInTheDocument();
    });

    click(within(dialog).getByLabelText("Clear search"));

    await waitFor(() => {
      expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    });

    openAgentRowMenu(dialog, "Research Agent");
    click(menuItemByText("Pin to sidebar"));

    await waitFor(() => {
      expect(
        within(agentRowByName(dialog, "Research Agent")).getByLabelText(
          "Open agent menu",
        ),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("Research Agent")).toBeInTheDocument();
    });

    openAgentRowMenu(dialog, "Research Agent");
    click(menuItemByText("Unpin"));

    await waitFor(() => {
      expect(
        within(sidebar).queryByText("Research Agent"),
      ).not.toBeInTheDocument();
    });

    openAgentRowMenu(dialog, "Research Agent");
    click(menuItemByText("Pin to sidebar"));

    await waitFor(() => {
      expect(
        within(agentRowByName(dialog, "Research Agent")).getByLabelText(
          "Open agent menu",
        ),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("Research Agent")).toBeInTheDocument();
    });

    click(within(dialog).getByRole("option", { name: /Research Agent/ }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Talk to" }),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar).getByText("Chats with Research Agent"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("Research kickoff")).toBeInTheDocument();
      expect(within(sidebar).queryByText("New chat")).not.toBeInTheDocument();
    });

    expect(createRequests).toBe(0);
  });

  it("opens the agent picker from the global shortcut", async () => {
    prepareAgentTeam();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(sidebar()).toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, {
      key: "a",
      ctrlKey: true,
      shiftKey: true,
    });

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
  });

  it("opens the agent picker from the global shortcut while composer is focused", async () => {
    prepareAgentTeam();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    composer.focus();
    fireEvent.keyDown(composer, {
      key: "a",
      ctrlKey: true,
      shiftKey: true,
    });

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
  });

  it("ignores global shortcuts while a dialog is open", async () => {
    prepareAgentTeam();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(sidebar()).toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, {
      key: "a",
      ctrlKey: true,
      shiftKey: true,
    });

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    expect(screen.queryByText("Keyboard Shortcuts")).not.toBeInTheDocument();
  });

  it("selects an agent from the picker with arrow keys and enter", async () => {
    prepareAgentTeam();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(sidebar()).toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, {
      key: "a",
      ctrlKey: true,
      shiftKey: true,
    });

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    const search = within(dialog).getByPlaceholderText("Search agents...");

    await fill(search, "support");

    await waitFor(() => {
      expect(
        within(dialog).queryByText("Research Agent"),
      ).not.toBeInTheDocument();
      expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
    });

    fireEvent.keyDown(search, { key: "ArrowDown" });
    fireEvent.keyDown(search, { key: "Enter" });

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Talk to" }),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Chats with Support Agent"),
      ).toBeInTheDocument();
    });
  });

  it("shows agent unread indicators and dropdown actions behind the feature switch", async () => {
    prepareAgentTeam();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
    let unreadAgentRequests = 0;
    context.mocks.api(chatThreadsContract.unreadAgents, ({ respond }) => {
      unreadAgentRequests += 1;
      return respond(200, { agentIds: unreadAgentIds });
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.AgentUnreadIndicators]: true },
    });

    const nav = await waitFor(() => {
      const current = sidebar();
      expect(within(current).getByText("Research Agent")).toBeInTheDocument();
      return current;
    });
    const researchSidebarRow = agentRowByName(nav, "Research Agent");
    await waitFor(() => {
      expect(
        within(researchSidebarRow).getByLabelText("Unread"),
      ).toBeInTheDocument();
      expect(
        within(researchSidebarRow).getByLabelText("Open agent menu"),
      ).toBeInTheDocument();
      expect(
        within(researchSidebarRow).queryByLabelText("Unpin"),
      ).not.toBeInTheDocument();
    });

    click(within(researchSidebarRow).getByLabelText("Open agent menu"));
    expect(menuItemByText("Unpin")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });

    click(within(nav).getByLabelText("Open a conversation"));
    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    const researchDialogRow = agentRowByName(dialog, "Research Agent");
    const supportDialogRow = agentRowByName(dialog, "Support Agent");
    expect(
      within(researchDialogRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(supportDialogRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(supportDialogRow).queryByLabelText("Pin to sidebar"),
    ).not.toBeInTheDocument();

    click(within(supportDialogRow).getByLabelText("Open agent menu"));
    expect(menuItemByText("Pin to sidebar")).toBeInTheDocument();
    fireEvent.keyDown(document.body, { key: "Escape" });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("chatThreadReadCursorUpdated"),
      ).toBeTruthy();
    });
    unreadAgentIds = [SUPPORT_AGENT_ID];
    context.mocks.ably.trigger("chatThreadReadCursorUpdated", {
      agentId: RESEARCH_AGENT_ID,
    });

    await waitFor(() => {
      expect(unreadAgentRequests).toBeGreaterThan(1);
      expect(
        within(researchSidebarRow).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
      expect(
        within(researchDialogRow).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
      expect(
        within(supportDialogRow).getByLabelText("Unread"),
      ).toBeInTheDocument();
    });
  });

  it("marks all pinned agent chats read from the agent menu", async () => {
    prepareAgentTeam();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
    const markedAgentIds: string[] = [];
    context.mocks.api(chatThreadsContract.unreadAgents, ({ respond }) => {
      return respond(200, { agentIds: unreadAgentIds });
    });
    context.mocks.api(
      chatThreadMarkAgentReadContract.markAgentRead,
      ({ body, respond }) => {
        markedAgentIds.push(body.agentId);
        unreadAgentIds = unreadAgentIds.filter((id) => {
          return id !== body.agentId;
        });
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.AgentUnreadIndicators]: true },
    });

    const nav = await waitFor(() => {
      const current = sidebar();
      expect(within(current).getByText("Research Agent")).toBeInTheDocument();
      return current;
    });
    const researchSidebarRow = agentRowByName(nav, "Research Agent");
    await waitFor(() => {
      expect(
        within(researchSidebarRow).getByLabelText("Unread"),
      ).toBeInTheDocument();
    });

    click(within(researchSidebarRow).getByLabelText("Open agent menu"));
    click(menuItemByText("Mark all read"));

    await waitFor(() => {
      expect(markedAgentIds).toStrictEqual([RESEARCH_AGENT_ID]);
      expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
      expect(
        within(researchSidebarRow).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
    });
  });

  it("marks all default agent chats read from the default agent menu", async () => {
    prepareAgentTeam();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    let unreadAgentIds = [AGENT_ID, SUPPORT_AGENT_ID];
    const markedAgentIds: string[] = [];
    context.mocks.api(chatThreadsContract.unreadAgents, ({ respond }) => {
      return respond(200, { agentIds: unreadAgentIds });
    });
    context.mocks.api(
      chatThreadMarkAgentReadContract.markAgentRead,
      ({ body, respond }) => {
        markedAgentIds.push(body.agentId);
        unreadAgentIds = unreadAgentIds.filter((id) => {
          return id !== body.agentId;
        });
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.AgentUnreadIndicators]: true },
    });

    const nav = await waitFor(() => {
      const current = sidebar();
      expect(within(current).getByText("Zero")).toBeInTheDocument();
      return current;
    });
    const defaultSidebarRow = agentRowByName(nav, "Zero");
    await waitFor(() => {
      expect(
        within(defaultSidebarRow).getByLabelText("Unread"),
      ).toBeInTheDocument();
      expect(
        within(defaultSidebarRow).getByLabelText("Open agent menu"),
      ).toBeInTheDocument();
    });

    click(within(defaultSidebarRow).getByLabelText("Open agent menu"));
    expect(menuItemByText("Mark all read")).toBeInTheDocument();
    expect(queryMenuItemByText("Unpin")).not.toBeInTheDocument();
    click(menuItemByText("Mark all read"));

    await waitFor(() => {
      expect(markedAgentIds).toStrictEqual([AGENT_ID]);
      expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
      expect(
        within(defaultSidebarRow).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
    });
  });

  it("collapses and reopens the sidebar", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    click(
      await waitFor(() => {
        return screen.getByLabelText("Collapse sidebar");
      }),
    );

    const expandButton = await screen.findByLabelText("Expand sidebar");
    click(expandButton);

    await waitFor(() => {
      expect(screen.queryByLabelText("Expand sidebar")).not.toBeInTheDocument();
      expect(screen.getByLabelText("Collapse sidebar")).toBeInTheDocument();
    });
  });

  it("collapses and reopens the manage navigation section", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const nav = await waitFor(() => {
      const current = sidebar();
      expect(within(current).getByText("Agents")).toBeInTheDocument();
      expect(within(current).getByText("Connectors")).toBeInTheDocument();
      return current;
    });

    const scrollArea = screen.getByTestId("sidebar-scroll-area");
    Object.defineProperty(scrollArea, "clientHeight", {
      configurable: true,
      value: 200,
    });
    Object.defineProperty(scrollArea, "scrollHeight", {
      configurable: true,
      value: 1000,
    });
    Object.defineProperty(scrollArea, "scrollTop", {
      configurable: true,
      value: 120,
    });
    fireEvent.scroll(scrollArea);

    await waitFor(() => {
      expect(scrollArea.getAttribute("style")).toContain("box-shadow:");
    });

    const scrollWrapper = scrollArea.parentElement;
    if (!scrollWrapper) {
      throw new Error("Sidebar scroll wrapper not found");
    }
    fireEvent.mouseEnter(scrollWrapper);
    fireEvent.mouseLeave(scrollWrapper);

    Object.defineProperty(scrollArea, "scrollHeight", {
      configurable: true,
      value: 200,
    });
    fireEvent.scroll(scrollArea);

    click(within(nav).getByText("Manage"));

    await waitFor(() => {
      expect(within(nav).queryByText("Agents")).not.toBeInTheDocument();
      expect(within(nav).queryByText("Connectors")).not.toBeInTheDocument();
    });

    click(within(nav).getByText("Manage"));

    await waitFor(() => {
      expect(within(nav).getByText("Agents")).toBeInTheDocument();
      expect(within(nav).getByText("Connectors")).toBeInTheDocument();
    });
  });

  it("shows workflows in the sidebar manage navigation when enabled", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.WorkflowAutomation]: true },
    });

    const nav = await waitFor(() => {
      return sidebar();
    });

    expect(within(nav).getByText("Agents")).toBeInTheDocument();
    const workflows = within(nav).getByText("Workflows");
    const connectors = within(nav).getByText("Connectors");
    expect(
      workflows.compareDocumentPosition(connectors) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(nav).queryByText("Automations")).not.toBeInTheDocument();
  });

  it("hides workflows in the sidebar manage navigation when disabled", async () => {
    prepareDefaultAgent();
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse([]));
    });

    detachedSetupPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const nav = await waitFor(() => {
      return sidebar();
    });

    expect(within(nav).getByText("Agents")).toBeInTheDocument();
    expect(within(nav).getByText("Automations")).toBeInTheDocument();
    expect(within(nav).queryByText("Workflows")).not.toBeInTheDocument();
  });
});
