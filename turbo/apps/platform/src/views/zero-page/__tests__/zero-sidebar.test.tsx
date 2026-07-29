import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  chatThreadByIdContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadEventsContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
} from "@vm0/api-contracts/contracts/chat-threads";
import { FeatureSwitchKey } from "@vm0/core/feature-switch-key";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";

import {
  createMockWorkflowAutomation,
  setMockWorkflowAutomations,
} from "../../../mocks/handlers/workflow-automations-store.ts";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname } from "../../../signals/location.ts";
import {
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  getChatThreadVirtualListScrollMargin,
} from "../../../signals/zero-page/zero-sidebar-state.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
const EXISTING_THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const INCIDENT_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const AUTOMATION_THREAD_ID = "b0000000-0000-4000-a000-000000000003";
const ARCHIVED_THREAD_ID = "b0000000-0000-4000-a000-000000000004";
const RESEARCH_THREAD_ID = "b0000000-0000-4000-a000-000000000005";

interface SidebarThread {
  readonly id: string;
  readonly title: string | null;
  readonly agent: { readonly id: string; readonly avatarUrl: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null;
  readonly renamedAt?: string | null;
}

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
    pinnedAt: null,
    ...overrides,
  };
}

function mockChatThreadSnapshot(
  threads: () => readonly SidebarThread[],
  activeThreadIds: () => readonly string[] = () => {
    return [];
  },
): void {
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    const snapshotThreads = threads();
    return respond(200, {
      chatThreads: snapshotThreads.map((thread, index) => {
        return {
          id: thread.id,
          agentId: thread.agent.id,
          title: thread.title,
          sortAt: new Date(
            Date.parse("2026-03-10T00:00:00Z") +
              (snapshotThreads.length - index) * 1000,
          ).toISOString(),
          createdAt: thread.createdAt,
          updatedAt: thread.updatedAt,
          pinnedAt: thread.pinnedAt ?? null,
          renamedAt: thread.renamedAt ?? null,
          selectedModel: null,
          serviceTier: null,
          computerUseHostId: null,
        };
      }),
      latestEventId: null,
      latestSeqId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
    return respond(200, { threadIds: [...activeThreadIds()] });
  });
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

function mobileSidebar(): HTMLElement {
  const drawer = screen.getByLabelText("Collapse sidebar").closest("aside");
  if (!(drawer instanceof HTMLElement)) {
    throw new Error("Mobile sidebar not found");
  }
  return drawer;
}

function pinnedAgentLink(
  container: HTMLElement,
  name: string,
): HTMLAnchorElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
    return candidate.textContent?.trim() === name;
  });
  if (!(link instanceof HTMLAnchorElement)) {
    throw new Error(`${name} pinned agent link not found`);
  }
  return link;
}

function setupSidebarPage(
  options: Parameters<typeof detachedSetupPage>[0],
): void {
  detachedSetupPage(options);
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

function agentRowActionRootForMenuTrigger(trigger: HTMLElement): HTMLElement {
  let current = trigger.parentElement;
  while (current instanceof HTMLElement) {
    if (current.style.getPropertyValue("--agent-row-trigger-opacity")) {
      return current;
    }
    current = current.parentElement;
  }
  throw new Error("Agent row action root not found");
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
  activeThreadIds: readonly string[] = [],
): {
  threads: SidebarThread[];
} {
  let threads = [...firstPageThreads];

  mockChatThreadSnapshot(
    () => {
      return [...threads, ...extraThreads];
    },
    () => {
      return activeThreadIds;
    },
  );

  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
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
    const threads = [
      {
        id: EXISTING_THREAD_ID,
        title: "Existing conversation",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      },
    ];
    mockChatThreadSnapshot(() => {
      return threads;
    });
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      await createDeferred.promise;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

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

  it("renders event-sourced sidebar threads while active run ids are pending", async () => {
    prepareDefaultAgent();
    let activeIdsRequests = 0;

    context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
      return respond(200, {
        chatThreads: [
          {
            id: EXISTING_THREAD_ID,
            agentId: AGENT_ID,
            title: "Event-sourced conversation",
            sortAt: "2026-03-10T00:00:00Z",
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            pinnedAt: null,
            renamedAt: null,
            selectedModel: null,
            serviceTier: null,
            computerUseHostId: null,
          },
        ],
        latestEventId: null,
        latestSeqId: null,
      });
    });
    context.mocks.api(chatThreadsContract.events, ({ respond }) => {
      return respond(200, { events: [], hasMore: false });
    });
    context.mocks.api(chatThreadsContract.activeIds, ({ never }) => {
      activeIdsRequests += 1;
      return never();
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Event-sourced conversation"),
      ).toBeInTheDocument();
      expect(
        sidebar().querySelectorAll('[data-testid="sidebar-skeleton"]'),
      ).toHaveLength(0);
      expect(activeIdsRequests).toBe(1);
    });
    expect(
      within(threadRowByTitle("Event-sourced conversation")).queryByLabelText(
        "Running",
      ),
    ).not.toBeInTheDocument();
  });

  it("keeps the sidebar responsive when a draft membership request rejects", async () => {
    prepareDefaultAgent();
    const draftResponse = context.mocks.deferred<void>();
    let draftRequests = 0;
    let draftResponseSent = false;

    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Existing conversation"),
    ]);
    context.mocks.api(chatThreadsContract.drafts, async ({ respond }) => {
      draftRequests += 1;
      await draftResponse.promise;
      draftResponseSent = true;
      return respond(401, {
        error: {
          code: "UNAUTHORIZED",
          message: "Draft membership unavailable",
        },
      });
    });

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(draftRequests).toBe(1);
      expect(
        within(sidebar()).getByText("Existing conversation"),
      ).toBeInTheDocument();
    });

    draftResponse.resolve();
    await waitFor(() => {
      expect(draftResponseSent).toBeTruthy();
      expect(
        within(sidebar()).getByText("Existing conversation"),
      ).toBeInTheDocument();
    });
    openChatListMenu();
    expect(menuItemByText("New chat")).toBeInTheDocument();
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
        pinnedAt: null,
      },
      {
        id: INCIDENT_THREAD_ID,
        title: "B server second",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-11T00:00:00Z",
        pinnedAt: null,
      },
      {
        id: AUTOMATION_THREAD_ID,
        title: "C server third",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-12T00:00:00Z",
        pinnedAt: null,
      },
    ];
    mockChatThreadSnapshot(() => {
      return serverOrderedThreads;
    });
    context.mocks.api(chatThreadsContract.create, async ({ body, respond }) => {
      await createDeferred.promise;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-12T12:00:00Z",
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

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

  it("requests unread chat threads and filters the event-sourced list", async () => {
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
    const allThreads = [
      pinnedUnreadThread,
      currentThread,
      unreadThread,
      archivedThread,
    ];
    let unreadsRequests = 0;

    mockChatThreadSnapshot(() => {
      return allThreads;
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      unreadsRequests += 1;
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

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Archived context"),
      ).toBeInTheDocument();
    });

    openChatListMenu();
    click(menuItemByText("Unread only"));

    await waitFor(() => {
      expect(unreadsRequests).toBeGreaterThan(0);
      expect(
        visibleThreadTitles(["Pinned incident", "Incident notes"]),
      ).toStrictEqual(["Pinned incident", "Incident notes"]);
      expect(
        within(sidebar()).queryByText("Release plan"),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar()).queryByText("Archived context"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps an event-sourced pinned current chat at the front of the pinned section", async () => {
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

    mockChatThreadSnapshot(() => {
      return [pinnedCurrentThread, pinnedThread, unpinnedThread];
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
      });
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, { unreads: [] });
    });

    setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

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
      chatThreadEventsContract.list,
      ({ params, query, respond }) => {
        if (
          query.sinceSeqId ||
          query.beforeSeqId ||
          query.sinceId ||
          query.beforeId
        ) {
          return respond(200, { events: [] });
        }
        return respond(200, {
          events:
            params.threadId === INCIDENT_THREAD_ID
              ? [
                  {
                    id: "incident-message-1",
                    threadId: INCIDENT_THREAD_ID,
                    eventType: "run.completed" as const,
                    runId: "mock-run",
                    content: "Incident update",
                    runLifecycleEvent: "completed",
                    seqId: 1,
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
          lastReadAt: "2026-03-10T00:05:00Z",
          unreads: [],
        });
      },
    );

    setupSidebarPage({ context, path: `/chats/${INCIDENT_THREAD_ID}` });

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
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(INCIDENT_THREAD_ID, "Incident notes"),
        createThread(AUTOMATION_THREAD_ID, "Running analysis"),
        createThread(ARCHIVED_THREAD_ID, "Draft brief"),
      ],
      [],
      [AUTOMATION_THREAD_ID],
    );
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

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
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
    );

    setupSidebarPage({
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
    expect(titleInput).toHaveValue("Release plan");

    await waitFor(() => {
      expect(dialog).toHaveStyle({ pointerEvents: "auto" });
    });

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

  it("prefills sidebar rename from event-driven thread metadata", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);

    setupSidebarPage({
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
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      "Incident notes",
    );
  });

  it("renames a chat thread by double-clicking from the sidebar", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(INCIDENT_THREAD_ID, "Incident notes"),
      ],
      [],
    );

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });

    fireEvent.doubleClick(threadLinkByTitle("Release plan"));

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    const titleInput = within(dialog).getByPlaceholderText("Chat title");
    expect(titleInput).toHaveValue("Release plan");

    await fill(titleInput, "Launch plan");
    click(buttonByText("Rename", dialog));

    await waitFor(() => {
      expect(within(sidebar()).getByText("Launch plan")).toBeInTheDocument();
      expect(
        within(sidebar()).queryByText("Release plan"),
      ).not.toBeInTheDocument();
    });
  });

  it("loads more sidebar chats and deletes a chat", async () => {
    prepareDefaultAgent();
    const overflowThreads = Array.from({ length: 23 }, (_, index) => {
      return createThread(
        `b1000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Overflow ${index + 1}`,
      );
    });
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
      ],
      [
        ...overflowThreads,
        createThread(ARCHIVED_THREAD_ID, "Archived context"),
      ],
    );
    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Scheduled launch"),
      ).toBeInTheDocument();
      expect(screen.queryByTestId("sidebar-chat-threads-load-more")).toBeNull();
    });

    openThreadMenu("Scheduled launch");
    click(menuItemByText("Delete chat"));

    const dialog = await screen.findByRole("dialog", {
      name: "Delete chat?",
    });
    click(buttonByText("Cancel", dialog));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: "Delete chat?",
        }),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Scheduled launch"),
      ).toBeInTheDocument();
    });

    openThreadMenu("Scheduled launch");
    click(menuItemByText("Delete chat"));

    const confirmDialog = await screen.findByRole("dialog", {
      name: "Delete chat?",
    });
    click(buttonByText("Delete", confirmDialog));

    await waitFor(() => {
      expect(
        within(sidebar()).queryByText("Scheduled launch"),
      ).not.toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });
  });

  it("virtualizes sidebar chats", async () => {
    prepareDefaultAgent();
    const overflowThreads = Array.from({ length: 23 }, (_, index) => {
      return createThread(
        `b2000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Virtual overflow ${index + 1}`,
      );
    });
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
      ],
      [
        ...overflowThreads,
        createThread(ARCHIVED_THREAD_ID, "Archived context"),
      ],
    );

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.queryByTestId("sidebar-chat-threads-load-more")).toBeNull();
      expect(
        screen.getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
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
      value: 0,
    });
    fireEvent.scroll(scrollArea);

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });
    expect(within(sidebar()).queryByText("Archived context")).toBeNull();

    Object.defineProperty(scrollArea, "scrollTop", {
      configurable: true,
      value: 780,
    });
    fireEvent.scroll(scrollArea);

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Archived context"),
      ).toBeInTheDocument();
    });
  });

  it("does not scroll the current chat into view from pointer focus after virtual scrolling", async () => {
    prepareDefaultAgent();
    const overflowThreads = Array.from({ length: 23 }, (_, index) => {
      return createThread(
        `b2100000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Touchable overflow ${index + 1}`,
      );
    });
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
      ],
      [
        ...overflowThreads,
        createThread(ARCHIVED_THREAD_ID, "Archived context"),
      ],
    );

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
    });

    const scrollArea = screen.getByTestId("sidebar-scroll-area");
    let scrollTop = 780;
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
      get: () => {
        return scrollTop;
      },
      set: (value) => {
        scrollTop = value;
      },
    });
    fireEvent.scroll(scrollArea);

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Archived context"),
      ).toBeInTheDocument();
    });

    fireEvent.pointerDown(scrollArea, { pointerType: "touch" });
    fireEvent.focus(scrollArea);

    expect(scrollTop).toBe(780);
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
  });

  it("keeps the chat thread focus ring inside the virtual row", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
    ]);

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    const link = await waitFor(() => {
      return threadLinkByTitle("Release plan");
    });

    expect(link).toHaveClass("focus-visible:outline-none");
    expect(link).toHaveClass("focus-visible:ring-2");
    expect(link).toHaveClass("focus-visible:ring-inset");
    expect(link).toHaveClass("focus-visible:ring-ring");
  });

  it("focuses the current main chat when the thread list receives focus", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
    ]);

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });

    screen.getByTestId("sidebar-scroll-area").focus();

    await waitFor(() => {
      expect(threadLinkByTitle("Release plan")).toHaveFocus();
    });
    expect(threadLinkByTitle("Incident notes")).not.toHaveFocus();
  });

  it("keeps pinned agents and the chat title outside the thread list scroll area", async () => {
    prepareAgentTeam();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });
    const overflowThreads = Array.from({ length: 23 }, (_, index) => {
      return createThread(
        `b2500000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Switched overflow ${index + 1}`,
      );
    });
    mockSidebarThreadStory(
      [
        createThread(EXISTING_THREAD_ID, "Release plan"),
        createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
      ],
      [
        ...overflowThreads,
        createThread(ARCHIVED_THREAD_ID, "Archived context"),
      ],
    );

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Research Agent")).toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(
        screen.getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
    });

    const scrollArea = screen.getByTestId("sidebar-scroll-area");
    const pinnedHeader = screen.getByTestId("pinned-section-header");
    const pinnedAgent = within(sidebar()).getByText("Research Agent");
    const chatTitle = within(sidebar()).getByText("Chats with Zero");
    expect(scrollArea).not.toContainElement(pinnedHeader);
    expect(scrollArea).not.toContainElement(pinnedAgent);
    expect(scrollArea).not.toContainElement(chatTitle);
    expect(scrollArea).toContainElement(threadLinkByTitle("Release plan"));

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
      value: 780,
    });
    fireEvent.scroll(scrollArea);

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Archived context"),
      ).toBeInTheDocument();
    });
  });

  it("scrolls the current chat into the virtualized sidebar on page setup", async () => {
    prepareDefaultAgent();
    const leadingThreads = Array.from({ length: 24 }, (_, index) => {
      return createThread(
        `b3000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Leading chat ${index + 1}`,
      );
    });
    mockSidebarThreadStory([
      ...leadingThreads,
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
    ]);

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      const scrollArea = screen.getByTestId("sidebar-scroll-area");
      expect(
        screen.getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(scrollArea.scrollTop).toBeGreaterThan(0);
    });
  });

  it("aligns the current virtualized chat row with the sidebar scroll area top on page setup", async () => {
    prepareDefaultAgent();
    const leadingThreads = Array.from({ length: 24 }, (_, index) => {
      return createThread(
        `b3100000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Leading precise chat ${index + 1}`,
      );
    });
    mockSidebarThreadStory([
      ...leadingThreads,
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
    ]);

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    });

    const scrollArea = screen.getByTestId("sidebar-scroll-area");
    const virtualList = screen.getByTestId("sidebar-chat-threads-virtual-list");
    const currentRow = threadLinkByTitle("Release plan").closest(
      '[data-testid="sidebar-chat-thread-virtual-row"]',
    );
    if (!(currentRow instanceof HTMLElement)) {
      throw new Error("Release plan virtual row not found");
    }
    const currentIndex = Number(currentRow.dataset.index);
    const scrollMargin = getChatThreadVirtualListScrollMargin(
      scrollArea,
      virtualList,
    );

    expect(scrollArea.scrollTop).toBe(
      scrollMargin + currentIndex * CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
    );
  });

  it("computes the virtual chat list margin relative to the scroll viewport", () => {
    const scrollViewport = document.createElement("div");
    const virtualList = document.createElement("div");
    Object.defineProperty(scrollViewport, "offsetTop", {
      configurable: true,
      value: 8,
    });
    Object.defineProperty(virtualList, "offsetTop", {
      configurable: true,
      value: 88,
    });

    expect(
      getChatThreadVirtualListScrollMargin(scrollViewport, virtualList),
    ).toBe(80);
  });

  it("cancels and confirms deleting a regular chat from the sidebar", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);

    setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

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
    const researchThread = createThread(
      RESEARCH_THREAD_ID,
      "Research kickoff",
      {
        agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
      },
    );

    mockChatThreadSnapshot(() => {
      return [researchThread];
    });
    context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
      createRequests += 1;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ChatThreadUnifiedSearch]: false },
    });

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

  it.each([
    { label: "single-column", threeColumnNav: false },
    { label: "three-column", threeColumnNav: true },
  ])(
    "closes the $label mobile sidebar after selecting a pinned agent",
    async ({ threeColumnNav }) => {
      prepareAgentTeam();
      context.mocks.data.userPreferences({
        pinnedAgentIds: [RESEARCH_AGENT_ID],
      });
      const openedTargets = context.mocks.browser.open();

      setupSidebarPage({
        context,
        path: `/agents/${AGENT_ID}/chat`,
        featureSwitches: {
          [FeatureSwitchKey.ThreeColumnNav]: threeColumnNav,
        },
      });

      await waitFor(() => {
        expect(
          pinnedAgentLink(mobileSidebar(), "Research Agent"),
        ).toBeInTheDocument();
      });

      click(screen.getByLabelText("Open menu"));
      await waitFor(() => {
        expect(mobileSidebar()).toHaveAttribute(
          "data-sidebar-expanded",
          "true",
        );
      });

      fireEvent.click(pinnedAgentLink(mobileSidebar(), "Research Agent"), {
        metaKey: true,
      });
      await waitFor(() => {
        expect(openedTargets.calls).toStrictEqual([
          expect.objectContaining({
            target: "_blank",
            url: expect.stringContaining(`/agents/${RESEARCH_AGENT_ID}/chat`),
          }),
        ]);
        expect(mobileSidebar()).toHaveAttribute(
          "data-sidebar-expanded",
          "true",
        );
      });

      click(pinnedAgentLink(mobileSidebar(), "Zero"));
      await waitFor(() => {
        expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
        expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
      });

      click(screen.getByLabelText("Open menu"));
      await waitFor(() => {
        expect(mobileSidebar()).toHaveAttribute(
          "data-sidebar-expanded",
          "true",
        );
      });

      click(pinnedAgentLink(mobileSidebar(), "Research Agent"));
      await waitFor(() => {
        expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
        expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
      });
    },
  );

  it("opens the agent picker from the global shortcut", async () => {
    prepareAgentTeam();

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

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

  it("shows chat thread title results in the picker behind the unified search switch", async () => {
    prepareAgentTeam();
    const defaultThread = createThread(EXISTING_THREAD_ID, "Incident notes");
    const researchThread = createThread(
      RESEARCH_THREAD_ID,
      "Research kickoff",
      {
        agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
      },
    );
    const supportThread = createThread(
      INCIDENT_THREAD_ID,
      "Support escalation",
      {
        agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
      },
    );
    mockSidebarThreadStory(
      [defaultThread, researchThread, supportThread],
      [],
      [INCIDENT_THREAD_ID],
    );
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, {
        unreads: [
          {
            threadId: EXISTING_THREAD_ID,
            unreadAt: "2026-03-10T00:05:00Z",
          },
        ],
      });
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ChatThreadUnifiedSearch]: true,
      },
    });

    await waitFor(() => {
      expect(sidebar()).toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, {
      key: "a",
      ctrlKey: true,
      shiftKey: true,
    });

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    const search = within(dialog).getByPlaceholderText(
      "Search agents and chats...",
    );

    await waitFor(() => {
      expect(within(dialog).getByText("Incident notes")).toBeInTheDocument();
      expect(
        within(dialog).getByText("Support escalation"),
      ).toBeInTheDocument();
      expect(
        within(agentRowByName(dialog, "Incident notes")).getByLabelText(
          "Unread",
        ),
      ).toBeInTheDocument();
      expect(
        within(agentRowByName(dialog, "Support escalation")).getByLabelText(
          "Running",
        ),
      ).toBeInTheDocument();
    });

    await fill(search, "research");

    await waitFor(() => {
      expect(within(dialog).getByText("Research kickoff")).toBeInTheDocument();
      expect(
        within(dialog).queryByText("Support escalation"),
      ).not.toBeInTheDocument();
    });

    await fill(search, "support");
    click(within(dialog).getByText("Support escalation"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Talk to" }),
      ).not.toBeInTheDocument();
      expect(document.title).toBe("Support escalation | VM0");
    });
  });

  it("opens the agent picker from the global shortcut while composer is focused", async () => {
    prepareAgentTeam();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    composer.focus();
    fireEvent.keyDown(composer, {
      key: "A",
      code: "KeyA",
      keyCode: 65,
      ctrlKey: true,
      shiftKey: true,
    });

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
  });

  it("moves to the next pinned agent chat from the composer", async () => {
    prepareAgentTeam();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    composer.focus();
    fireEvent.keyDown(composer, {
      key: "}",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
    });
  });

  it("moves to an unread unpinned agent shown in the sidebar", async () => {
    prepareAgentTeam();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });
    context.mocks.api(chatThreadsContract.unreadAgents, ({ respond }) => {
      return respond(200, { agentIds: [SUPPORT_AGENT_ID] });
    });

    setupSidebarPage({
      context,
      path: `/agents/${RESEARCH_AGENT_ID}/chat`,
    });

    const nav = await waitFor(() => {
      const current = sidebar();
      expect(within(current).getByText("Support Agent")).toBeInTheDocument();
      return current;
    });
    expect(
      within(agentRowByName(nav, "Support Agent")).getByLabelText("Unread"),
    ).toBeInTheDocument();

    fireEvent.keyDown(document.body, {
      key: "}",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
    });
  });

  it("keeps the chat list owner without carrying rows across agent scopes", async () => {
    prepareAgentTeam();
    const supportUnreadGate = context.mocks.deferred<void>();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
    });
    const researchThread = createThread(
      RESEARCH_THREAD_ID,
      "Research kickoff",
      {
        agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
      },
    );
    const supportThread = createThread(
      INCIDENT_THREAD_ID,
      "Support escalation",
      {
        agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
      },
    );
    const olderSupportThread = createThread(
      AUTOMATION_THREAD_ID,
      "Support archive",
      {
        agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
      },
    );
    mockSidebarThreadStory([researchThread, supportThread, olderSupportThread]);
    context.mocks.api(
      chatThreadsContract.unreads,
      async ({ query, respond }) => {
        if (query.agentId === SUPPORT_AGENT_ID) {
          await supportUnreadGate.promise;
        }
        const threadId =
          query.agentId === SUPPORT_AGENT_ID
            ? INCIDENT_THREAD_ID
            : RESEARCH_THREAD_ID;
        return respond(200, {
          unreads: [
            {
              threadId,
              unreadAt: "2026-03-10T00:05:00Z",
            },
          ],
        });
      },
    );

    setupSidebarPage({
      context,
      path: `/chats/${RESEARCH_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Research kickoff"),
      ).toBeInTheDocument();
    });
    openChatListMenu();
    click(menuItemByText("Unread only"));
    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Research kickoff"),
      ).toBeInTheDocument();
    });
    const chatList = within(sidebar()).getByLabelText("Chat threads");

    fireEvent.keyDown(document.body, {
      key: "}",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${INCIDENT_THREAD_ID}`);
      expect(
        within(sidebar()).queryByText("Research kickoff"),
      ).not.toBeInTheDocument();
      expect(within(sidebar()).getByLabelText("Chat threads")).toBe(chatList);
    });

    supportUnreadGate.resolve(undefined);
    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Support escalation"),
      ).toBeInTheDocument();
      expect(within(sidebar()).getByLabelText("Chat threads")).toBe(chatList);
    });
  });

  it("falls back to the pinned agent chat when the next pinned agent has no thread", async () => {
    prepareAgentTeam();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
    });
    const researchThread = createThread(
      RESEARCH_THREAD_ID,
      "Research kickoff",
      {
        agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
      },
    );
    mockSidebarThreadStory([researchThread]);

    setupSidebarPage({ context, path: `/chats/${RESEARCH_THREAD_ID}` });

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Research kickoff"),
      ).toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, {
      key: "}",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
    });
  });

  it("toggles the sidebar with mod+b while the chat composer is focused", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    await waitFor(() => {
      expect(screen.getByLabelText("Collapse sidebar")).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand sidebar")).not.toBeInTheDocument();
    });

    composer.focus();
    expect(composer).toHaveFocus();
    fireEvent.keyDown(composer, {
      key: "b",
      code: "KeyB",
      keyCode: 66,
      ctrlKey: true,
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Expand sidebar")).toBeInTheDocument();
    });
  });

  it("opens shortcut help from the agent chat page when composer is not focused", async () => {
    prepareAgentTeam();

    detachedSetupPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(sidebar()).toBeInTheDocument();
    });

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    const dialog = await screen.findByRole("dialog", {
      name: "Keyboard Shortcuts",
    });
    expect(within(dialog).getByText("Show shortcuts")).toBeInTheDocument();
  });

  it("ignores global shortcuts while a dialog is open", async () => {
    prepareAgentTeam();

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

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

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.ChatThreadUnifiedSearch]: false },
    });

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

  it("shows agent unread indicators and dropdown actions", async () => {
    prepareAgentTeam();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });

    let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
    let unreadAgentRequests = 0;
    context.mocks.api(chatThreadsContract.unreadAgents, ({ respond }) => {
      unreadAgentRequests += 1;
      return respond(200, { agentIds: unreadAgentIds });
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const nav = await waitFor(() => {
      const current = sidebar();
      expect(within(current).getByText("Research Agent")).toBeInTheDocument();
      return current;
    });
    const researchSidebarRow = agentRowByName(nav, "Research Agent");
    const supportSidebarRow = await waitFor(() => {
      return agentRowByName(nav, "Support Agent");
    });
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
      expect(
        within(supportSidebarRow).getByLabelText("Unread"),
      ).toBeInTheDocument();
    });

    click(within(supportSidebarRow).getByLabelText("Open agent menu"));
    expect(menuItemByText("Mark all read")).toBeInTheDocument();
    expect(menuItemByText("Pin to sidebar")).toBeInTheDocument();
    expect(queryMenuItemByText("Unpin")).not.toBeInTheDocument();
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

    click(within(researchSidebarRow).getByLabelText("Open agent menu"));
    expect(menuItemByText("Unpin")).toBeInTheDocument();
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });

    click(within(nav).getByLabelText("Open a conversation"));
    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    const researchDialogRow = agentRowByName(dialog, "Research Agent");
    const supportDialogRow = agentRowByName(dialog, "Support Agent");
    expect(
      within(researchDialogRow).queryByLabelText("Reorder Research Agent"),
    ).not.toBeInTheDocument();
    const researchDialogUnread =
      within(researchDialogRow).getByLabelText("Unread");
    const supportDialogUnread =
      within(supportDialogRow).getByLabelText("Unread");
    expect(researchDialogUnread).toBeInTheDocument();
    expect(researchDialogUnread).toBeVisible();
    expect(supportDialogUnread).toBeInTheDocument();
    expect(supportDialogUnread).toBeVisible();
    expect(
      within(supportDialogRow).queryByLabelText("Pin to sidebar"),
    ).not.toBeInTheDocument();

    const supportMenuTrigger =
      within(supportDialogRow).getByLabelText("Open agent menu");
    const supportActionRoot =
      agentRowActionRootForMenuTrigger(supportMenuTrigger);
    fireEvent.pointerEnter(supportActionRoot);
    expect(supportDialogUnread).not.toBeVisible();
    fireEvent.pointerLeave(supportActionRoot);
    expect(supportDialogUnread).toBeVisible();

    click(supportMenuTrigger);
    expect(supportDialogUnread).not.toBeVisible();
    expect(menuItemByText("Pin to sidebar")).toBeInTheDocument();
    click(supportMenuTrigger);
    await waitFor(() => {
      expect(screen.queryByText("Pin to sidebar")).not.toBeInTheDocument();
    });
    fireEvent.pointerLeave(supportActionRoot);
    await waitFor(() => {
      expect(within(supportDialogRow).getByLabelText("Unread")).toBeVisible();
    });

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
        within(supportSidebarRow).getByLabelText("Unread"),
      ).toBeInTheDocument();
      expect(
        within(researchDialogRow).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
      expect(
        within(supportDialogRow).getByLabelText("Unread"),
      ).toBeInTheDocument();
      expect(within(supportDialogRow).getByLabelText("Unread")).toBeVisible();
    });
  });

  it("marks all pinned agent chats read from the agent menu", async () => {
    prepareAgentTeam();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
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

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
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

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
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

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

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

  it("uses CSS hover for the scrollbar and toggles the manage section", async () => {
    prepareDefaultAgent();

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

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
    const scrollbarTrack = scrollArea.nextElementSibling;
    if (!(scrollbarTrack instanceof HTMLElement)) {
      throw new Error("Sidebar scrollbar track not found");
    }

    expect(scrollWrapper).toHaveClass("group/sidebar-scroll");
    expect(scrollbarTrack).toHaveClass(
      "opacity-0",
      "transition-opacity",
      "duration-150",
      "group-hover/sidebar-scroll:opacity-100",
    );
    expect(scrollbarTrack.style.opacity).toBe("");
    fireEvent.mouseEnter(scrollWrapper);
    fireEvent.mouseLeave(scrollWrapper);
    expect(scrollbarTrack.style.opacity).toBe("");

    Object.defineProperty(scrollArea, "scrollHeight", {
      configurable: true,
      value: 200,
    });
    fireEvent.scroll(scrollArea);
    expect(scrollbarTrack).not.toHaveClass(
      "group-hover/sidebar-scroll:opacity-100",
    );

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

  it("orders artifacts after connectors in the manage navigation", async () => {
    prepareDefaultAgent();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: { [FeatureSwitchKey.Artifacts]: true },
    });

    const nav = await waitFor(() => {
      return sidebar();
    });

    expect(within(nav).getByText("Agents")).toBeInTheDocument();
    const workflows = within(nav).getByText("Workflows");
    const connectors = within(nav).getByText("Connectors");
    const artifacts = within(nav).getByText("Artifacts");
    expect(
      workflows.compareDocumentPosition(connectors) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      connectors.compareDocumentPosition(artifacts) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(within(nav).queryByText("Automations")).not.toBeInTheDocument();
  });

  it("renders the three-column navigation when the flag is on", async () => {
    prepareDefaultAgent();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.ThreeColumnNav]: true,
      },
    });

    const rail = await waitFor(() => {
      return screen.getByTestId("labeled-nav-rail");
    });

    // Labeled icon rail carries text captions for its nav destinations.
    expect(within(rail).getByText("Agents")).toBeInTheDocument();
    expect(within(rail).getByText("Connectors")).toBeInTheDocument();
    expect(within(rail).getByLabelText("Insights")).toBeInTheDocument();

    // The middle list column owns the chat header and pinned agents.
    const list = screen.getByTestId("chat-list-column");
    expect(within(list).getByText("Chat")).toBeInTheDocument();
    expect(within(list).getByLabelText("New chat")).toBeInTheDocument();
    expect(
      within(list).getByTestId("pinned-agents-horizontal"),
    ).toBeInTheDocument();
  });

  it("keeps the single-column sidebar when the three-column flag is off", async () => {
    prepareDefaultAgent();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await waitFor(() => {
      return sidebar();
    });

    expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
    expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  });

  it("localizes desktop and mobile shell navigation and shortcut help", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Localized conversation"),
    ]);
    setMockWorkflowAutomations([
      createMockWorkflowAutomation({
        chatThreadId: EXISTING_THREAD_ID,
      }),
    ]);
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
      featureSwitches: {
        [FeatureSwitchKey.Artifacts]: true,
        [FeatureSwitchKey.LanguagePreference]: true,
        [FeatureSwitchKey.ThreeColumnNav]: true,
        [FeatureSwitchKey.ZeroDebug]: true,
      },
    });

    const rail = await screen.findByTestId("labeled-nav-rail");
    expect(
      within(rail).getByRole("navigation", { name: "Barra lateral" }),
    ).toBeInTheDocument();
    expect(within(rail).getByText("Agentes")).toBeInTheDocument();
    expect(within(rail).getByText("Fluxos")).toBeInTheDocument();
    expect(within(rail).getByText("Conectores")).toBeInTheDocument();
    expect(within(rail).getByText("Artefatos")).toBeInTheDocument();
    expect(within(rail).getByText("Atividade")).toBeInTheDocument();
    expect(
      within(rail).getByLabelText("Onde Zero trabalha"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Abrir menu")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Abrir artefatos no celular"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Abrir automações no celular"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Recolher barra lateral")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    const dialog = await screen.findByRole("dialog", {
      name: "Atalhos de teclado",
    });
    expect(
      within(dialog).getByText("Atalhos disponíveis nesta página"),
    ).toBeInTheDocument();
    expect(within(dialog).getByText("Mostrar atalhos")).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("Fechar atalhos de teclado"),
    ).toBeInTheDocument();
  });

  it("keeps localized navigation accessible while collapsing and expanding", async () => {
    prepareDefaultAgent();
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
      featureSwitches: {
        [FeatureSwitchKey.LanguagePreference]: true,
        [FeatureSwitchKey.ZeroDebug]: true,
      },
    });

    const nav = await screen.findByRole("navigation", {
      name: "Barra lateral",
    });
    expect(within(nav).getByText("Gerenciar")).toBeInTheDocument();
    expect(within(nav).getByText("Fluxos de trabalho")).toBeInTheDocument();
    expect(within(nav).getByText("Logs de atividade")).toBeInTheDocument();

    click(screen.getByLabelText("Recolher barra lateral"));

    const expandButton = await screen.findByLabelText("Expandir barra lateral");
    expect(
      screen.getAllByRole("navigation", { name: "Barra lateral" }).length,
    ).toBeGreaterThan(0);
    expect(screen.getByLabelText("Agentes")).toBeInTheDocument();
    expect(screen.getByLabelText("Logs de atividade")).toBeInTheDocument();

    click(expandButton);
    await screen.findByLabelText("Recolher barra lateral");
  });
});
