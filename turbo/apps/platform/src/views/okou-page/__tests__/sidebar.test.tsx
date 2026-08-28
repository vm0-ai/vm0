import {
  act,
  cleanup,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import {
  chatSearchContract,
  chatThreadByIdContract,
  chatThreadMarkAgentReadContract,
  chatThreadMarkReadContract,
  chatThreadMarkUnreadContract,
  chatThreadEventsContract,
  chatThreadPinContract,
  chatThreadRenameContract,
  chatThreadUnpinContract,
  chatThreadsContract,
} from "@okouai/api-contracts/contracts/chat-threads";
import {
  agentsByIdContract,
  agentsMainContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import { userPreferencesContract } from "@okouai/api-contracts/contracts/user-preferences";
import {
  workflowsCollectionContract,
  workflowsDetailContract,
  type WorkflowDetailResponse,
} from "@okouai/api-contracts/contracts/workflows";
import {
  createMockWorkflowAutomation,
  setMockWorkflowAutomations,
} from "../../../mocks/handlers/workflow-automations-store.ts";
import {
  click,
  detachedSetupPage,
  fill,
  holdElementAnimations,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { isoFromNowMs, mockNow } from "../../../__tests__/time.ts";
import { emptySearchImg } from "../platform-assets.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { eventDrivenChatThread } from "../../../signals/chat-page/chat-thread-event-sourcing.ts";
import { setChatPageImageModelSelection$ } from "../../../signals/okou-page/chat-page.ts";
import {
  CHAT_THREAD_VIRTUAL_ROW_HEIGHT,
  getChatThreadVirtualListScrollMargin,
} from "../../../signals/okou-page/sidebar-state.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { mockChatEventRows } from "./chat-event-test-helpers.ts";

// The composer editor is mounted on first paint and mounted again once page
// bootstrap settles, so an element captured too early is detached before a test
// can drive it. Keyboard events on a detached editor are silently dropped.
function mountedComposer(): HTMLElement {
  const composer = document.querySelector(
    '.zero-composer [contenteditable="true"]',
  );
  if (!(composer instanceof HTMLElement)) {
    throw new Error("Composer editor is not mounted");
  }
  return composer;
}

const context = testContext();
const refreshContext = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const RESEARCH_AGENT_ID = "c0000000-0000-4000-a000-000000000002";
const SUPPORT_AGENT_ID = "c0000000-0000-4000-a000-000000000003";
const EXISTING_THREAD_ID = "b0000000-0000-4000-a000-000000000001";
const INCIDENT_THREAD_ID = "b0000000-0000-4000-a000-000000000002";
const AUTOMATION_THREAD_ID = "b0000000-0000-4000-a000-000000000003";
const ARCHIVED_THREAD_ID = "b0000000-0000-4000-a000-000000000004";
const RESEARCH_THREAD_ID = "b0000000-0000-4000-a000-000000000005";
const WORKFLOW_ID = "d0000000-0000-4000-a000-000000000001";
const ARTIFACT_ID = "a0000000-0000-4000-a000-000000000001";

interface SidebarThread {
  readonly id: string;
  readonly title: string | null;
  readonly agent: { readonly id: string; readonly avatarUrl: string | null };
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly pinnedAt?: string | null;
  readonly renamedAt?: string | null;
  /** Overrides the ordering-derived `sortAt` when a test asserts on its age. */
  readonly sortAt?: string;
}

function prepareDefaultAgent(): void {
  context.mocks.data.agents([
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      visibility: "public",
    },
  ]);
}

function prepareAgents(targetContext = context): AgentResponse[] {
  const agents: AgentResponse[] = [
    {
      agentId: AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Zero",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    },
    {
      agentId: RESEARCH_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Research Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    },
    {
      agentId: SUPPORT_AGENT_ID,
      ownerId: "test-user-123",
      displayName: "Support Agent",
      description: null,
      sound: null,
      avatarUrl: null,
      modelProviderId: null,
      selectedModel: null,
      preferPersonalProvider: false,
      visibility: "public",
    },
  ];
  targetContext.mocks.data.agents(agents);
  targetContext.mocks.api(agentsByIdContract.get, ({ params, respond }) => {
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
      visibility: "public",
    });
  });
  return agents;
}

const OVERFLOW_PINNED_AGENTS = [
  {
    agentId: "c0000000-0000-4000-a000-000000000004",
    displayName: "Operations Agent",
  },
  {
    agentId: "c0000000-0000-4000-a000-000000000005",
    displayName: "Analytics Agent",
  },
  {
    agentId: "c0000000-0000-4000-a000-000000000006",
    displayName: "Billing Agent",
  },
] as const;

/**
 * Pins five agents so the grid holds six cards plus Pin, which overflows the
 * five-column row and puts cards on both sides of the Pin button.
 */
function prepareOverflowingPinnedAgents(targetContext = context): string[] {
  const agents = prepareAgents(targetContext);
  targetContext.mocks.data.agents([
    ...agents,
    ...OVERFLOW_PINNED_AGENTS.map((agent) => {
      return {
        ...agents[1]!,
        agentId: agent.agentId,
        displayName: agent.displayName,
      };
    }),
  ]);
  return [
    RESEARCH_AGENT_ID,
    SUPPORT_AGENT_ID,
    ...OVERFLOW_PINNED_AGENTS.map((agent) => {
      return agent.agentId;
    }),
  ];
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
          sortAt:
            thread.sortAt ??
            new Date(
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
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: Object.fromEntries(
        activeThreadIds().map((threadId) => {
          return [threadId, "active" as const];
        }),
      ),
    });
  });
}

function mockUnreadAgents(
  unreadAgentIds: () => readonly string[],
  onRequest: () => void = () => {},
): void {
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    onRequest();
    return respond(200, {
      agents: Object.fromEntries(
        unreadAgentIds().map((agentId) => {
          return [agentId, "unread" as const];
        }),
      ),
      threads: {},
    });
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

function buttonByLabel(
  label: string,
  container: ParentNode = document.body,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function sidebar(): HTMLElement {
  return screen.getByTestId("chat-list-column");
}

function mobileSidebar(): HTMLElement {
  const drawer = document.querySelector("aside.zero-pwa-fixed-cover");
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

function pinnedAgentNames(container: HTMLElement): string[] {
  return within(container)
    .getAllByTestId("pinned-agent-card")
    .map((card) => {
      return card.textContent?.trim() ?? "";
    });
}

/** Names of the given agents as the dialog lists them, in rendered order. */
function dialogAgentOrder(
  dialog: HTMLElement,
  names: readonly string[],
): string[] {
  return within(dialog)
    .getAllByRole("option")
    .map((option) => {
      return names.find((name) => {
        return option.textContent?.replace(/\s+/g, " ").trim().startsWith(name);
      });
    })
    .filter((name): name is string => {
      return name !== undefined;
    });
}

function commandItemByText(container: HTMLElement, text: string): HTMLElement {
  const item = within(container)
    .getAllByRole("option")
    .find((candidate) => {
      return candidate.textContent
        ?.replace(/\s+/g, " ")
        .trim()
        .startsWith(text);
    });
  if (!item) {
    throw new Error(`${text} command item not found`);
  }
  return item;
}

/**
 * jsdom does not implement DataTransfer, so drag events need a stub that keeps
 * the payload the pinned grid writes on drag start.
 */
function createDataTransferStub(
  initialValues: Readonly<Record<string, string>> = {},
): DataTransfer {
  let values = new Map<string, string>(Object.entries(initialValues));
  return {
    effectAllowed: "none",
    dropEffect: "none",
    clearData: (format?: string) => {
      if (format === undefined) {
        values = new Map<string, string>();
        return;
      }
      values.delete(format);
    },
    setData: (format: string, value: string) => {
      values.set(format, value);
    },
    getData: (format: string) => {
      return values.get(format) ?? "";
    },
  } as unknown as DataTransfer;
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
      cancellationRecoveryPending: false,
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
    let createdThreadBody: { readonly videoModel?: string } | undefined;
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
      createdThreadBody = body;
      await createDeferred.promise;
      return respond(201, {
        id: body.clientThreadId ?? "created-thread-id",
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
        selectedModel: body.model ?? "claude-sonnet-4-6",
        serviceTier: body.serviceTier ?? null,
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
        cancellationRecoveryPending: false,
      });
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const newChatButton = await waitFor(() => {
      expect(
        within(sidebar()).getByText("Existing conversation"),
      ).toBeInTheDocument();
      return within(sidebar()).getByLabelText("Open chat list menu");
    });

    click(newChatButton);
    click(menuItemByText("New chat"));

    await waitFor(() => {
      const sidebar = screen.getByTestId("chat-list-column");
      expect(
        within(sidebar).getByText("Existing conversation"),
      ).toBeInTheDocument();
      expect(within(sidebar).getByText("New chat")).toBeInTheDocument();
      expect(
        sidebar.querySelectorAll('[data-testid="sidebar-skeleton"]'),
      ).toHaveLength(0);
      expect(createdThreadBody).toBeDefined();
    });
    expect(createdThreadBody?.videoModel).toBeUndefined();

    createDeferred.resolve();
  });

  it("renders event-sourced sidebar threads while indicators are pending", async () => {
    prepareDefaultAgent();
    let indicatorRequests = 0;

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
    context.mocks.api(chatThreadsContract.indicators, ({ never }) => {
      indicatorRequests += 1;
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
      expect(indicatorRequests).toBe(1);
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
        selectedModel: body.model ?? "claude-sonnet-4-6",
        serviceTier: body.serviceTier ?? null,
      });
    });
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        lastReadAt: null,
        cancellationRecoveryPending: false,
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
      return within(sidebar()).getByLabelText("Open chat list menu");
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
        cancellationRecoveryPending: false,
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
        cancellationRecoveryPending: false,
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
      chatThreadEventsContract.rows,
      ({ params, query, respond }) => {
        return respond(200, {
          rows: mockChatEventRows(
            params.threadId === INCIDENT_THREAD_ID
              ? [
                  {
                    id: "incident-message-1",
                    threadId: INCIDENT_THREAD_ID,
                    eventType: "run.completed" as const,
                    runId: "mock-run",
                    content: null,
                    runLifecycleEvent: "completed" as const,
                    seqId: 1,
                    createdAt: "2026-03-10T00:05:00Z",
                  },
                ]
              : [],
          ).filter((row) => {
            return row.seqId > query.sinceSeqId;
          }),
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

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("chatThreadReadCursorUpdated"),
      ).toBeTruthy();
    });
    context.mocks.ably.trigger("chatThreadReadCursorUpdated", {
      threadId: INCIDENT_THREAD_ID,
      agentId: AGENT_ID,
      lastReadAt: null,
    });

    await waitFor(() => {
      expect(
        within(threadRowByTitle("Incident notes")).getByLabelText("Unread"),
      ).toBeInTheDocument();
    });
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
    expect(
      within(threadRowByTitle("Incident notes")).getByLabelText("Unread"),
    ).toHaveAttribute("role", "img");
    expect(
      within(threadRowByTitle("Draft brief")).getByLabelText("Draft"),
    ).toHaveAttribute("role", "img");

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

  it("marks the current chat unread from the sidebar menu", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Release plan"),
      createThread(INCIDENT_THREAD_ID, "Incident notes"),
    ]);
    let markedUnreadThreadId: string | null = null;
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, {
        unreads:
          markedUnreadThreadId === null
            ? []
            : [
                {
                  threadId: markedUnreadThreadId,
                  unreadAt: "2026-03-10T00:05:00Z",
                },
              ],
      });
    });
    context.mocks.api(
      chatThreadMarkUnreadContract.markUnread,
      ({ params, respond }) => {
        markedUnreadThreadId = params.id;
        return respond(200, {
          lastReadAt: null,
          unreads: [
            {
              threadId: params.id,
              unreadAt: "2026-03-10T00:05:00Z",
            },
          ],
        });
      },
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
    click(menuItemByText("Mark unread"));

    await waitFor(() => {
      expect(markedUnreadThreadId).toBe(EXISTING_THREAD_ID);
    });
    expect(
      within(threadRowByTitle("Release plan")).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();

    click(threadLinkByTitle("Incident notes"));

    await waitFor(() => {
      expect(
        within(threadRowByTitle("Release plan")).getByLabelText("Unread"),
      ).toBeInTheDocument();
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

    await fill(titleInput, "Launch plan");
    click(buttonByText("Rename", dialog));

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

  it("keeps the rename draft while closing and resets it on the next open", async () => {
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

    openThreadMenu("Release plan");
    click(menuItemByText("Rename chat"));

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    const titleInput = within(dialog).getByPlaceholderText("Chat title");
    await fill(titleInput, "Unsaved title");
    const finishCloseAnimation = holdElementAnimations(dialog);
    click(buttonByText("Cancel", dialog));

    expect(titleInput).toBeInTheDocument();
    expect(titleInput).toBeVisible();
    expect(titleInput).toHaveValue("Unsaved title");

    finishCloseAnimation();

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Rename chat" }),
      ).not.toBeInTheDocument();
    });

    openThreadMenu("Incident notes");
    click(menuItemByText("Rename chat"));

    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Rename chat",
    });
    expect(
      within(reopenedDialog).getByPlaceholderText("Chat title"),
    ).toHaveValue("Incident notes");
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
      expect(
        within(sidebar()).queryByTestId("sidebar-chat-threads-load-more"),
      ).toBeNull();
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
      expect(
        within(sidebar()).queryByTestId("sidebar-chat-threads-load-more"),
      ).toBeNull();
      expect(
        within(sidebar()).getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
    });

    const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
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

  it("keeps three-column desktop and mobile chat virtualization isolated", async () => {
    prepareDefaultAgent();
    const overflowThreads = Array.from({ length: 23 }, (_, index) => {
      return createThread(
        `b2050000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Isolated overflow ${index + 1}`,
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

    const desktopList = await screen.findByTestId("chat-list-column");
    const mobileList = mobileSidebar();
    const desktopScrollArea = await within(desktopList).findByTestId(
      "sidebar-scroll-area",
    );
    const mobileScrollArea = await within(mobileList).findByTestId(
      "sidebar-scroll-area",
    );
    Object.defineProperties(desktopScrollArea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 780, writable: true },
    });
    Object.defineProperties(mobileScrollArea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 0, writable: true },
    });

    fireEvent.scroll(mobileScrollArea);
    fireEvent.scroll(desktopScrollArea);

    await waitFor(() => {
      expect(
        within(desktopList).getByText("Archived context"),
      ).toBeInTheDocument();
      expect(within(desktopList).queryByText("Release plan")).toBeNull();
      expect(within(mobileList).getByText("Release plan")).toBeInTheDocument();
      expect(within(mobileList).queryByText("Archived context")).toBeNull();
    });
  });

  it("keeps virtualized chats visible after deletion refreshes a clamped viewport", async () => {
    prepareDefaultAgent();
    const overflowThreads = Array.from({ length: 23 }, (_, index) => {
      return createThread(
        `b3000000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Refresh overflow ${index + 1}`,
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
        within(sidebar()).getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
    });

    const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
    Object.defineProperties(scrollArea, {
      clientHeight: { configurable: true, value: 200 },
      scrollHeight: { configurable: true, value: 1000 },
      scrollTop: { configurable: true, value: 780, writable: true },
    });
    fireEvent.scroll(scrollArea);

    await waitFor(() => {
      expect(
        within(sidebar()).getByText("Archived context"),
      ).toBeInTheDocument();
    });
    expect(within(sidebar()).queryByText("Release plan")).toBeNull();

    openThreadMenu("Archived context");
    click(menuItemByText("Delete chat"));
    const dialog = await screen.findByRole("dialog", {
      name: "Delete chat?",
    });
    click(buttonByText("Delete", dialog));

    // Model a browser-clamped live offset without another scroll event.
    scrollArea.scrollTop = 0;

    await waitFor(() => {
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(
        within(sidebar()).queryByText("Archived context"),
      ).not.toBeInTheDocument();
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
        within(sidebar()).getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
    });

    const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
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

    within(sidebar()).getByTestId("sidebar-scroll-area").focus();

    await waitFor(() => {
      expect(threadLinkByTitle("Release plan")).toHaveFocus();
    });
    expect(threadLinkByTitle("Incident notes")).not.toHaveFocus();
  });

  it("keeps pinned agents and the chat title outside the thread list scroll area", async () => {
    prepareAgents();
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
        within(sidebar()).getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
    });

    const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
    const pinnedHeader = within(sidebar()).getByTestId(
      "pinned-agents-horizontal",
    );
    const pinnedAgent = within(pinnedHeader).getByText("Research Agent");
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

  it("leaves the footer as the only owner of the gap below the thread list", async () => {
    prepareDefaultAgent();
    mockChatThreadSnapshot(() => {
      return [createThread(EXISTING_THREAD_ID, "Release plan")];
    });

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      return within(sidebar()).getByText("Chats with Zero");
    });

    const content = within(sidebar()).getByTestId(
      "pinned-agents-horizontal",
    ).parentElement;
    if (!(content instanceof HTMLElement)) {
      throw new Error("Chat list content wrapper not found");
    }

    // The footer below supplies the bottom boundary out of its own padding.
    // A bottom padding here stacks a second one on top of it, which reads as
    // a void under the last thread row.
    expect(content).toHaveClass("px-3", "pt-1");
    expect(content).not.toHaveClass("p-3");
    expect(content).not.toHaveClass("pb-3");
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
      const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
      expect(
        within(sidebar()).getByTestId("sidebar-chat-threads-virtual-list"),
      ).toBeInTheDocument();
      expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
      expect(scrollArea.scrollTop).toBeGreaterThan(0);
    });
  });

  it("scrolls the current chat in the three-column desktop list on page setup", async () => {
    prepareDefaultAgent();
    const leadingThreads = Array.from({ length: 24 }, (_, index) => {
      return createThread(
        `b3050000-0000-4000-a000-${String(index).padStart(12, "0")}`,
        `Three-column leading chat ${index + 1}`,
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

    const desktopList = await screen.findByTestId("chat-list-column");
    await waitFor(() => {
      expect(within(desktopList).getByText("Release plan")).toBeInTheDocument();
      expect(
        within(desktopList).getByTestId("sidebar-scroll-area").scrollTop,
      ).toBeGreaterThan(0);
    });
  });

  it("renders 100 chat threads before the sidebar viewport is measured", async () => {
    prepareDefaultAgent();
    const firstThread = createThread(EXISTING_THREAD_ID, "Fallback chat 1");
    const threads = [
      firstThread,
      ...Array.from({ length: 119 }, (_, index) => {
        return createThread(
          `b3200000-0000-4000-a000-${String(index).padStart(12, "0")}`,
          `Fallback chat ${index + 2}`,
        );
      }),
    ];
    mockSidebarThreadStory(threads);

    setupSidebarPage({
      context,
      path: `/chats/${firstThread.id}`,
    });

    await waitFor(() => {
      expect(
        within(sidebar()).getAllByTestId("sidebar-chat-thread-virtual-row"),
      ).toHaveLength(100);
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

    const scrollArea = within(sidebar()).getByTestId("sidebar-scroll-area");
    const virtualList = within(sidebar()).getByTestId(
      "sidebar-chat-threads-virtual-list",
    );
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
        "This will permanently delete this chat. Any task currently running in this chat will be stopped immediately. Any linked automations will be paused. This action cannot be undone.",
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

  it("shows cached agents when opening the conversation picker", async () => {
    const team = prepareAgents();
    const releaseRefresh = context.mocks.deferred<void>();
    let initialTeamServed = false;
    context.mocks.api(agentsMainContract.list, async ({ respond }) => {
      if (initialTeamServed) {
        await releaseRefresh.promise;
      }
      initialTeamServed = true;
      return respond(200, team);
    });

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const sidebar = await waitFor(() => {
      const currentSidebar = mobileSidebar();
      expect(pinnedAgentLink(currentSidebar, "Zero")).toBeInTheDocument();
      return currentSidebar;
    });

    click(within(sidebar).getByLabelText("Open a conversation"));

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    await expect(
      within(dialog).findByText("Research Agent"),
    ).resolves.toBeInTheDocument();
  });

  it("lists pinned agents in pinned order under the three-column nav", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [SUPPORT_AGENT_ID, RESEARCH_AGENT_ID],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(pinnedAgentNames(grid)).toStrictEqual([
        "Zero",
        "Support Agent",
        "Research Agent",
      ]);
    });

    click(screen.getByLabelText("Pin an agent"));

    const dialogList = await screen.findByTestId("pin-agent-dialog-list");
    expect(
      dialogAgentOrder(dialogList, ["Research Agent", "Support Agent"]),
    ).toStrictEqual(["Support Agent", "Research Agent"]);
  });

  it("pins an agent from the conversation picker and opens that agent chat", async () => {
    prepareAgents();
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
        selectedModel: body.model ?? "claude-sonnet-4-6",
        serviceTier: body.serviceTier ?? null,
      });
    });

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const initialSidebar = await waitFor(() => {
      return mobileSidebar();
    });
    click(within(initialSidebar).getByLabelText("Open a conversation"));

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();

    await fill(
      within(dialog).getByPlaceholderText("Search agents and chats..."),
      "support",
    );

    await waitFor(() => {
      expect(
        within(dialog).queryByText("Research Agent"),
      ).not.toBeInTheDocument();
      expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
    });

    await fill(
      within(dialog).getByPlaceholderText("Search agents and chats..."),
      "ops",
    );

    await waitFor(() => {
      expect(within(dialog).getByText("No results found")).toBeInTheDocument();
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
      expect(
        within(initialSidebar).getByText("Research Agent"),
      ).toBeInTheDocument();
    });

    openAgentRowMenu(dialog, "Research Agent");
    click(menuItemByText("Unpin"));

    await waitFor(() => {
      expect(
        within(initialSidebar).queryByText("Research Agent"),
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
      expect(
        within(initialSidebar).getByText("Research Agent"),
      ).toBeInTheDocument();
    });

    click(within(dialog).getByRole("option", { name: /Research Agent/ }));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Talk to" }),
      ).not.toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Chats with Research Agent"),
      ).toBeInTheDocument();
      expect(
        within(sidebar()).getByText("Research kickoff"),
      ).toBeInTheDocument();
      expect(within(sidebar()).queryByText("New chat")).not.toBeInTheDocument();
    });

    expect(createRequests).toBe(0);
  });

  it("closes the mobile sidebar after selecting a pinned agent", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });
    const openedTargets = context.mocks.browser.open();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await waitFor(() => {
      expect(
        pinnedAgentLink(mobileSidebar(), "Research Agent"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Open menu"));
    await waitFor(() => {
      expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
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
      expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
    });

    click(pinnedAgentLink(mobileSidebar(), "Zero"));
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
      expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
    });

    click(screen.getByLabelText("Open menu"));
    await waitFor(() => {
      expect(mobileSidebar()).toHaveAttribute("data-sidebar-expanded", "true");
    });

    click(pinnedAgentLink(mobileSidebar(), "Research Agent"));
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
      expect(mobileSidebar()).not.toHaveAttribute("data-sidebar-expanded");
    });
  });

  it("opens the agent picker from the global shortcut", async () => {
    prepareAgents();

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

  it("shows chat thread title results in the conversation picker", async () => {
    prepareAgents();
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

  it("unifies local thread titles with indexed message matches", async () => {
    prepareAgents();
    context.mocks.data.agents([
      {
        agentId: AGENT_ID,
        ownerId: "test-user-123",
        displayName: "Zero",
        description: null,
        sound: null,
        avatarUrl: null,
        visibility: "public",
      },
      {
        agentId: RESEARCH_AGENT_ID,
        ownerId: "test-user-123",
        displayName: "Deploy alpha",
        description: null,
        sound: null,
        avatarUrl: null,
        visibility: "public",
      },
      {
        agentId: SUPPORT_AGENT_ID,
        ownerId: "test-user-123",
        displayName: "Planning deploy",
        description: null,
        sound: null,
        avatarUrl: null,
        visibility: "public",
      },
      {
        agentId: "c0000000-0000-4000-a000-000000000004",
        ownerId: "test-user-123",
        displayName: "Deploy beta",
        description: null,
        sound: null,
        avatarUrl: null,
        visibility: "public",
      },
      {
        agentId: "c0000000-0000-4000-a000-000000000005",
        ownerId: "test-user-123",
        displayName: "Deploy gamma",
        description: null,
        sound: null,
        avatarUrl: null,
        visibility: "public",
      },
    ]);
    const deployThread = createThread(RESEARCH_THREAD_ID, "Deployment notes", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    });
    const deployFollowup = createThread(
      INCIDENT_THREAD_ID,
      "Deployment follow-up",
      { agent: { id: RESEARCH_AGENT_ID, avatarUrl: null } },
    );
    const deployArchive = createThread(
      AUTOMATION_THREAD_ID,
      "Deployment archive",
      { agent: { id: RESEARCH_AGENT_ID, avatarUrl: null } },
    );
    mockSidebarThreadStory([deployThread, deployFollowup, deployArchive]);
    const searchResponse = context.mocks.deferred<void>();
    let requestedKeyword: string | undefined;
    context.mocks.api(chatSearchContract.search, async ({ query, respond }) => {
      requestedKeyword = query.keyword;
      await searchResponse.promise;
      return respond(200, {
        results: Array.from({ length: 25 }, (_, index) => {
          return {
            chatThreadId: RESEARCH_THREAD_ID,
            agentName: "Research Agent",
            matchedMessage: {
              chatThreadId: RESEARCH_THREAD_ID,
              role: "user" as const,
              content: `Production deploy ${index + 1} finished successfully`,
              createdAt: "2026-03-10T00:10:00Z",
              seqId: index + 1,
              runId: null,
            },
            matchedRanges: [{ start: 11, end: 17 }],
            contextBefore: [],
            contextAfter: [],
          };
        }),
        hasMore: false,
      });
    });

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

    await waitFor(() => {
      expect(sidebar()).toBeInTheDocument();
    });
    click(within(mobileSidebar()).getByLabelText("Open a conversation"));

    const dialog = await screen.findByRole("dialog", { name: "Talk to" });
    await fill(
      within(dialog).getByPlaceholderText("Search agents and chats..."),
      "deploy",
    );

    await waitFor(() => {
      expect(requestedKeyword).toBe("deploy");
      expect(within(dialog).getByText("Deployment notes")).toBeInTheDocument();
      expect(
        within(dialog).getByText("Deployment archive"),
      ).toBeInTheDocument();
      expect(within(dialog).getByText("Searching...")).toBeInTheDocument();
    });

    searchResponse.resolve();

    await waitFor(() => {
      expect(
        within(dialog).queryByText("Searching..."),
      ).not.toBeInTheDocument();
      expect(within(dialog).getAllByText("Deployment notes")).toHaveLength(22);
      expect(
        within(dialog).queryByText("Deployment archive"),
      ).not.toBeInTheDocument();
    });
    const [highlighted] = within(dialog).getAllByText("deploy");
    if (!highlighted) {
      throw new Error("Highlighted message search term not found");
    }
    expect(highlighted).toHaveClass("text-foreground");

    const results = within(dialog).getAllByRole("option");
    expect(results).toHaveLength(25);
    expect(results[0]).toHaveTextContent("Deploy alpha");
    expect(results[1]).toHaveTextContent("Deploy beta");
    expect(results[2]).toHaveTextContent("Deployment notes");
    expect(results[3]).toHaveTextContent("Deployment follow-up");
    expect(results[4]).toHaveTextContent(
      "Production deploy 1 finished successfully",
    );
    expect(within(dialog).queryByText("Deploy gamma")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("Planning deploy"),
    ).not.toBeInTheDocument();
    const messageResult = highlighted.closest('[role="option"]');
    if (!(messageResult instanceof HTMLElement)) {
      throw new Error("Message search result not found");
    }
    click(messageResult);

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Talk to" }),
      ).not.toBeInTheDocument();
      expect(document.title).toBe("Deployment notes | VM0");
    });
  });

  it("opens the agent picker from the global shortcut while composer is focused", async () => {
    prepareAgents();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await screen.findByPlaceholderText(PLACEHOLDER);
    await waitFor(() => {
      if (screen.queryByRole("dialog", { name: "Talk to" })) {
        return;
      }
      const composer = mountedComposer();
      composer.focus();
      fireEvent.keyDown(composer, {
        key: "A",
        code: "KeyA",
        keyCode: 65,
        ctrlKey: true,
        shiftKey: true,
      });
      throw new Error("Agent picker has not opened yet");
    });

    const dialog = screen.getByRole("dialog", { name: "Talk to" });
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
    expect(within(dialog).getByText("Support Agent")).toBeInTheDocument();
  });

  it("opens three-column conversation search with mod+k from the composer", async () => {
    prepareAgents();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await screen.findByPlaceholderText(PLACEHOLDER);
    const composer = mountedComposer();
    composer.focus();
    const event = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(event);

    expect(event.defaultPrevented).toBeTruthy();
    const dialog = await screen.findByRole("dialog", {
      name: "Search chats, messages, workflows, and artifacts...",
    });
    expect(dialog).toBeInTheDocument();
  });

  it("moves to the next pinned agent chat from the composer", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await screen.findByPlaceholderText(PLACEHOLDER);
    await waitFor(() => {
      if (pathname() === `/agents/${RESEARCH_AGENT_ID}/chat`) {
        return;
      }
      const composer = mountedComposer();
      composer.focus();
      fireEvent.keyDown(composer, {
        key: "}",
        ctrlKey: true,
        shiftKey: true,
      });
      throw new Error("Pinned agent navigation has not happened yet");
    });
    expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
  });

  it("moves to an unread unpinned agent shown in the sidebar", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });
    mockUnreadAgents(() => {
      return [SUPPORT_AGENT_ID];
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
    prepareAgents();
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
    prepareAgents();
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

  it("toggles the chat list with mod+b while the chat composer is focused", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);

    detachedSetupPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    const composer = await screen.findByPlaceholderText(PLACEHOLDER);
    const list = await screen.findByTestId("chat-list-column");
    await waitFor(() => {
      expect(within(list).getByLabelText("Hide chat list")).toBeInTheDocument();
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
      expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
      expect(
        within(screen.getByTestId("labeled-nav-rail")).getByLabelText(
          "Show chat list",
        ),
      ).toBeInTheDocument();
    });
  });

  it("opens shortcut help from the agent chat page when composer is not focused", async () => {
    prepareAgents();

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
    prepareAgents();

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
    prepareAgents();

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
    const search = within(dialog).getByPlaceholderText(
      "Search agents and chats...",
    );

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
    prepareAgents();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });

    let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
    let unreadAgentRequests = 0;
    mockUnreadAgents(
      () => {
        return unreadAgentIds;
      },
      () => {
        unreadAgentRequests += 1;
      },
    );

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const nav = await waitFor(() => {
      const current = mobileSidebar();
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
    prepareAgents();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID],
    });

    let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
    const markedAgentIds: string[] = [];
    mockUnreadAgents(() => {
      return unreadAgentIds;
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
      const current = mobileSidebar();
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
    prepareAgents();

    let hasUnread = true;
    const markedAgentIds: string[] = [];
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        agents: { [AGENT_ID]: hasUnread ? "unread" : "active" },
        threads: {
          [INCIDENT_THREAD_ID]: "active",
          ...(hasUnread ? { [EXISTING_THREAD_ID]: "unread" as const } : {}),
        },
      });
    });
    context.mocks.api(
      chatThreadMarkAgentReadContract.markAgentRead,
      ({ body, respond }) => {
        markedAgentIds.push(body.agentId);
        hasUnread = false;
        return respond(204);
      },
    );

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const nav = await waitFor(() => {
      const current = mobileSidebar();
      expect(within(current).getByText("Zero")).toBeInTheDocument();
      return current;
    });
    const defaultSidebarRow = agentRowByName(nav, "Zero");
    const defaultUnread = await waitFor(() => {
      return within(defaultSidebarRow).getByLabelText("Unread");
    });
    const defaultMenuTrigger =
      within(defaultSidebarRow).getByLabelText("Open agent menu");
    expect(defaultUnread).toBeVisible();

    click(defaultMenuTrigger);
    expect(menuItemByText("Mark all read")).toBeInTheDocument();
    expect(queryAllByRoleFast("menuitem")).toHaveLength(1);
    expect(queryMenuItemByText("Unpin")).not.toBeInTheDocument();
    click(menuItemByText("Mark all read"));

    await waitFor(() => {
      expect(markedAgentIds).toStrictEqual([AGENT_ID]);
      expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
      expect(
        within(defaultSidebarRow).queryByLabelText("Unread"),
      ).not.toBeInTheDocument();
      expect(
        within(defaultSidebarRow).queryByLabelText("Open agent menu"),
      ).not.toBeInTheDocument();
    });
  });

  it("hides and reopens the chat list", async () => {
    prepareDefaultAgent();

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const list = await screen.findByTestId("chat-list-column");
    click(within(list).getByLabelText("Hide chat list"));

    const rail = await screen.findByTestId("labeled-nav-rail");
    click(within(rail).getByLabelText("Show chat list"));

    await waitFor(() => {
      expect(screen.getByTestId("chat-list-column")).toBeInTheDocument();
    });
  });

  it("localizes agent navigation and the conversation dialog in Brazilian Portuguese", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const nav = await waitFor(() => {
      const drawer = mobileSidebar();
      expect(within(drawer).getByText("Agentes")).toBeInTheDocument();
      return drawer;
    });

    click(within(nav).getByLabelText("Abrir uma conversa"));

    const dialog = await screen.findByRole("dialog", {
      name: "Conversar com",
    });
    expect(within(dialog).getByLabelText("Fechar")).toBeInTheDocument();
  });

  it("localizes agent navigation in the three-column rail", async () => {
    prepareDefaultAgent();
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const rail = await screen.findByTestId("labeled-nav-rail");
    expect(within(rail).getByText("Agentes")).toBeInTheDocument();
  });

  it("uses CSS hover for the scrollbar and toggles the manage section", async () => {
    prepareDefaultAgent();

    setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

    const nav = await waitFor(() => {
      const current = mobileSidebar();
      expect(within(current).getByText("Agents")).toBeInTheDocument();
      expect(within(current).getByText("Connectors")).toBeInTheDocument();
      return current;
    });

    const scrollArea = within(nav).getByTestId("sidebar-scroll-area");
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
    });

    const nav = await waitFor(() => {
      return mobileSidebar();
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

  it("renders the three-column navigation", async () => {
    prepareDefaultAgent();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const rail = await waitFor(() => {
      return screen.getByTestId("labeled-nav-rail");
    });

    // Labeled icon rail carries text captions for its nav destinations.
    expect(within(rail).getByText("Agents")).toBeInTheDocument();
    expect(within(rail).getByText("Connectors")).toBeInTheDocument();

    // The middle list column owns the chat header and pinned agents.
    const list = screen.getByTestId("chat-list-column");
    expect(within(list).getByText("Chat")).toBeInTheDocument();
    const searchButton = within(list).getByLabelText("Search workspace");
    const newChatButton = within(list).getByLabelText("New chat");
    expect(searchButton).toHaveAttribute(
      "aria-keyshortcuts",
      "Meta+K Control+K",
    );
    expect(newChatButton).toBeInTheDocument();
    expect(
      within(list).getByTestId("pinned-agents-horizontal"),
    ).toBeInTheDocument();
  });

  it("keeps the new-chat rail responsive across consecutive clicks", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Existing conversation"),
    ]);

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    const rail = await screen.findByTestId("labeled-nav-rail");
    await screen.findByPlaceholderText(PLACEHOLDER);
    expect(
      within(screen.getByTestId("chat-list-column")).getByText(
        "Existing conversation",
      ),
    ).toBeInTheDocument();
    const newChatLink = within(rail).getByLabelText("New chat");
    click(newChatLink);

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    });
    click(
      within(screen.getByTestId("labeled-nav-rail")).getByLabelText("New chat"),
    );

    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });
  });

  it("hides only the three-column chat list and keeps search available", async () => {
    prepareDefaultAgent();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    await screen.findByPlaceholderText(PLACEHOLDER);
    const rail = await screen.findByTestId("labeled-nav-rail");
    const list = screen.getByTestId("chat-list-column");
    const hideButton = within(list).getByLabelText("Hide chat list");
    expect(hideButton).toHaveAttribute("aria-keyshortcuts", "Meta+B Control+B");

    click(hideButton);

    await waitFor(() => {
      expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
    });
    expect(rail).toBeInTheDocument();
    const showButton = within(rail).getByLabelText("Show chat list");
    expect(showButton).toHaveAttribute("aria-keyshortcuts", "Meta+B Control+B");

    const composer = mountedComposer();
    composer.focus();
    const searchEvent = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    composer.dispatchEvent(searchEvent);

    expect(searchEvent.defaultPrevented).toBeTruthy();
    const dialog = await screen.findByRole("dialog", {
      name: "Search chats, messages, workflows, and artifacts...",
    });
    fireEvent.keyDown(dialog, { key: "Escape", code: "Escape" });
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", {
          name: "Search chats, messages, workflows, and artifacts...",
        }),
      ).not.toBeInTheDocument();
    });

    const restoredComposer = mountedComposer();
    restoredComposer.focus();
    fireEvent.keyDown(restoredComposer, {
      key: "b",
      code: "KeyB",
      keyCode: 66,
      ctrlKey: true,
    });

    await waitFor(() => {
      expect(screen.getByTestId("chat-list-column")).toBeInTheDocument();
      expect(
        within(rail).queryByLabelText("Show chat list"),
      ).not.toBeInTheDocument();
    });
  });

  it("keeps the three-column chat list on one text and box inset", async () => {
    prepareDefaultAgent();

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const list = await waitFor(() => {
      return screen.getByTestId("chat-list-column");
    });

    const pinnedSection = within(list).getByTestId("pinned-agents-horizontal");
    const scroller = pinnedSection.parentElement;
    if (!(scroller instanceof HTMLElement)) {
      throw new Error("Chat list content wrapper is not rendered");
    }

    // Rows, the pinned grid and the section labels all sit on a 12px content
    // inset, and each label adds its own pl-2 so every text in the column
    // starts at the same 20px. Dropping either half pulls one of them out of
    // line with the rest.
    expect(scroller).toHaveClass("px-3");
    expect(scroller).not.toHaveClass("px-2");
    expect(within(list).getByText("Chat")).toHaveClass("pl-2");

    // The pinned label carries the same h-8 row box as the chats section title
    // below it, which is what keeps the gap above the two section headers even.
    const pinnedLabel = within(pinnedSection).getByText("Pinned agents");
    expect(pinnedLabel).toHaveClass("flex", "h-8", "items-center", "pl-2");
    expect(pinnedLabel).not.toHaveClass("pb-2");

    expect(
      within(list).getByRole("region", { name: "Chat threads" }),
    ).toBeInTheDocument();

    // The label row supplies that bottom gap, so the grid must not stack a
    // second one under the avatars.
    const grid = within(pinnedSection).getByTestId("pinned-agents-grid");
    expect(grid).not.toHaveClass("pb-1");
  });

  it("shows a visible unread indicator on a pinned agent", async () => {
    prepareDefaultAgent();
    mockUnreadAgents(() => {
      return [AGENT_ID];
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    const card = await waitFor(() => {
      return within(grid).getByTestId("pinned-agent-card");
    });
    const unread = await waitFor(() => {
      return within(card).getByLabelText("Unread");
    });

    expect(unread).toBeVisible();
    expect(unread).toHaveAttribute("role", "img");
  });

  it("searches chats and messages in the three-column spotlight", async () => {
    prepareAgents();
    mockSidebarThreadStory([
      createThread(RESEARCH_THREAD_ID, "Deployment notes", {
        agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
      }),
      createThread(INCIDENT_THREAD_ID, "Incident response", {
        agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
      }),
    ]);
    context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
      return respond(200, {
        results:
          query.keyword === "deploy"
            ? [
                {
                  chatThreadId: INCIDENT_THREAD_ID,
                  agentName: "Support Agent",
                  matchedMessage: {
                    chatThreadId: INCIDENT_THREAD_ID,
                    role: "user" as const,
                    content: "Production deploy completed successfully",
                    createdAt: "2026-03-10T00:10:00Z",
                    seqId: 1,
                    runId: null,
                  },
                  matchedRanges: [{ start: 11, end: 17 }],
                  contextBefore: [],
                  contextAfter: [],
                },
              ]
            : [],
        hasMore: false,
      });
    });
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, { artifacts: [], nextCursor: null });
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const list = await screen.findByTestId("chat-list-column");
    click(within(list).getByLabelText("Search workspace"));

    const dialog = await screen.findByRole("dialog", {
      name: "Search chats, messages, workflows, and artifacts...",
    });
    expect(
      screen.queryByRole("dialog", { name: "Talk to" }),
    ).not.toBeInTheDocument();
    await fill(
      within(dialog).getByPlaceholderText(
        "Search chats, messages, workflows, and artifacts...",
      ),
      "deploy",
    );

    await waitFor(() => {
      expect(within(dialog).getByText("2 results")).toBeInTheDocument();
      expect(within(dialog).getByText("Deployment notes")).toBeInTheDocument();
      expect(within(dialog).getByText("Incident response")).toBeInTheDocument();
      expect(
        within(dialog).queryByText("Research Agent"),
      ).not.toBeInTheDocument();
    });

    click(buttonByText("Messages", dialog));
    expect(
      within(dialog).queryByText("Deployment notes"),
    ).not.toBeInTheDocument();
    expect(within(dialog).getByText("Incident response")).toBeInTheDocument();

    await fill(
      within(dialog).getByPlaceholderText(
        "Search chats, messages, workflows, and artifacts...",
      ),
      "missing",
    );
    await waitFor(() => {
      expect(within(dialog).getByText("No results found")).toBeInTheDocument();
      expect(within(dialog).getByText("0 results")).toBeInTheDocument();
    });

    await fill(
      within(dialog).getByPlaceholderText(
        "Search chats, messages, workflows, and artifacts...",
      ),
      "deploy",
    );
    click(buttonByText("Chats", dialog));
    await waitFor(() => {
      expect(within(dialog).getByText("Deployment notes")).toBeInTheDocument();
      expect(
        within(dialog).queryByText("Incident response"),
      ).not.toBeInTheDocument();
    });

    click(within(dialog).getByText("Deployment notes"));
    await waitFor(() => {
      expect(pathname()).toBe(`/chats/${RESEARCH_THREAD_ID}`);
      expect(
        screen.queryByRole("dialog", {
          name: "Search chats, messages, workflows, and artifacts...",
        }),
      ).not.toBeInTheDocument();
    });
  });

  it("searches workflows and artifacts in the three-column spotlight", async () => {
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: vi.fn<HTMLElement["scrollIntoView"]>(),
    });
    prepareAgents();
    mockSidebarThreadStory([
      createThread(RESEARCH_THREAD_ID, "Launch notes", {
        agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
      }),
      createThread(INCIDENT_THREAD_ID, "Incident response", {
        agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
      }),
    ]);
    context.mocks.api(chatSearchContract.search, ({ query, respond }) => {
      return respond(200, {
        results:
          query.keyword === "launch"
            ? [
                {
                  chatThreadId: INCIDENT_THREAD_ID,
                  agentName: "Support Agent",
                  matchedMessage: {
                    chatThreadId: INCIDENT_THREAD_ID,
                    role: "user" as const,
                    content: "Prepare the launch checklist",
                    createdAt: "2026-03-10T00:10:00Z",
                    seqId: 1,
                    runId: null,
                  },
                  matchedRanges: [{ start: 12, end: 18 }],
                  contextBefore: [],
                  contextAfter: [],
                },
              ]
            : [],
        hasMore: false,
      });
    });
    const workflow: WorkflowDetailResponse = {
      id: WORKFLOW_ID,
      agentId: RESEARCH_AGENT_ID,
      agentName: "research-agent",
      agentDisplayName: "Research Agent",
      name: "launch-workflow",
      displayName: "Launch workflow",
      description: "Prepare a launch plan",
      visibility: "private",
      ownerUserId: "test-user-123",
      ownerUserDisplayName: "Test User",
      ownerUserImageUrl: null,
      createdAt: "2026-03-10T00:05:00.000Z",
      canManage: true,
      canPublish: true,
      createdByUserId: "test-user-123",
      updatedByUserId: "test-user-123",
      updatedAt: "2026-03-10T00:05:00.000Z",
      instruction: "Prepare a launch plan",
      files: [],
      fileContents: [],
      automations: [],
    };
    context.mocks.api(workflowsCollectionContract.list, ({ respond }) => {
      return respond(200, [workflow]);
    });
    context.mocks.api(workflowsDetailContract.get, ({ respond }) => {
      return respond(200, workflow);
    });
    context.mocks.api(artifactCatalogContract.list, ({ query, respond }) => {
      return respond(200, {
        artifacts:
          query.keyword === "launch" || query.kind === "video"
            ? [
                {
                  id: ARTIFACT_ID,
                  kind: "video",
                  title: "launch-demo.mp4",
                  thumbnail: {
                    url: "https://cdn.vm0.io/artifacts/test/launch-demo.webp",
                  },
                  createdAt: "2026-03-10T00:06:00.000Z",
                  updatedAt: "2026-03-10T00:06:00.000Z",
                },
              ]
            : [],
        nextCursor: null,
      });
    });
    context.mocks.api(artifactCatalogContract.get, ({ respond }) => {
      return respond(200, {
        id: ARTIFACT_ID,
        kind: "video",
        title: "launch-demo.mp4",
        thumbnail: null,
        createdAt: "2026-03-10T00:06:00.000Z",
        updatedAt: "2026-03-10T00:06:00.000Z",
        file: {
          id: "f0000000-0000-4000-a000-000000000001",
          filename: "launch-demo.mp4",
          contentType: "video/mp4",
          size: 4096,
          url: "https://artifacts.example.com/launch-demo.mp4",
          previewImageUrl: null,
        },
        model: "video-model",
        durationSeconds: 12,
      });
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const list = await screen.findByTestId("chat-list-column");
    click(within(list).getByLabelText("Search workspace"));
    let dialog = await screen.findByRole("dialog", {
      name: "Search chats, messages, workflows, and artifacts...",
    });
    await fill(
      within(dialog).getByPlaceholderText(
        "Search chats, messages, workflows, and artifacts...",
      ),
      "launch",
    );

    await waitFor(() => {
      expect(within(dialog).getByText("4 results")).toBeInTheDocument();
      expect(within(dialog).getByText("Launch notes")).toBeInTheDocument();
      expect(within(dialog).getByText("Incident response")).toBeInTheDocument();
      expect(within(dialog).getByText("Launch workflow")).toBeInTheDocument();
      expect(within(dialog).getByText("launch-demo.mp4")).toBeInTheDocument();
    });
    const artifactThumbnail = within(dialog).getByTestId(
      "spotlight-artifact-thumbnail",
    );
    expect(artifactThumbnail).toHaveAttribute(
      "src",
      "https://cdn.vm0.io/cdn-cgi/image/width=64,fit=scale-down,format=auto,quality=85,metadata=none/artifacts/test/launch-demo.webp",
    );
    expect(artifactThumbnail).toHaveAttribute("loading", "eager");
    fireEvent.error(artifactThumbnail);
    await waitFor(() => {
      expect(artifactThumbnail).toHaveClass("hidden");
      expect(
        within(dialog).getByTestId("spotlight-artifact-kind-icon-video"),
      ).toBeInTheDocument();
    });

    click(buttonByText("Workflows", dialog));
    expect(within(dialog).getByText("Launch workflow")).toBeInTheDocument();
    expect(within(dialog).queryByText("Launch notes")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("launch-demo.mp4"),
    ).not.toBeInTheDocument();

    click(buttonByText("Artifacts", dialog));
    expect(within(dialog).getByText("launch-demo.mp4")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Launch workflow"),
    ).not.toBeInTheDocument();
    click(within(dialog).getByText("launch-demo.mp4"));

    await waitFor(() => {
      expect(pathname()).toBe("/artifacts");
      const params = new URLSearchParams(search());
      expect(params.get("tab")).toBe("video");
      expect(params.get("artifact")).toBe(ARTIFACT_ID);
    });
    await expect(
      screen.findByLabelText("Video preview for launch-demo.mp4"),
    ).resolves.toHaveAttribute(
      "src",
      "https://artifacts.example.com/launch-demo.mp4",
    );
    click(buttonByLabel("Close"));
    await waitFor(() => {
      expect(
        screen.queryByLabelText("Video preview for launch-demo.mp4"),
      ).not.toBeInTheDocument();
      expect(pathname()).toBe("/artifacts");
      const params = new URLSearchParams(search());
      expect(params.get("tab")).toBe("video");
      expect(params.has("artifact")).toBeFalsy();
    });

    act(() => {
      window.history.back();
    });
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    });

    const searchEvent = new KeyboardEvent("keydown", {
      key: "k",
      code: "KeyK",
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    });
    document.body.dispatchEvent(searchEvent);
    expect(searchEvent.defaultPrevented).toBeTruthy();
    dialog = await screen.findByRole("dialog", {
      name: "Search chats, messages, workflows, and artifacts...",
    });
    await fill(
      within(dialog).getByPlaceholderText(
        "Search chats, messages, workflows, and artifacts...",
      ),
      "launch",
    );
    click(buttonByText("Workflows", dialog));
    click(await within(dialog).findByText("Launch workflow"));

    await waitFor(() => {
      expect(pathname()).toBe(`/workflows/${WORKFLOW_ID}`);
    });
  });

  it("ages spotlight rows and illustrates the empty result set", async () => {
    mockNow(context.signal);
    prepareAgents();
    mockSidebarThreadStory([
      createThread(RESEARCH_THREAD_ID, "Minutes old", {
        sortAt: isoFromNowMs(-5 * 60 * 1000),
      }),
      createThread(INCIDENT_THREAD_ID, "Hours old", {
        sortAt: isoFromNowMs(-3 * 60 * 60 * 1000),
      }),
      createThread(AUTOMATION_THREAD_ID, "Days old", {
        sortAt: isoFromNowMs(-2 * 24 * 60 * 60 * 1000),
      }),
      createThread(ARCHIVED_THREAD_ID, "Older than a month", {
        sortAt: isoFromNowMs(-60 * 24 * 60 * 60 * 1000),
      }),
    ]);
    context.mocks.api(chatSearchContract.search, ({ respond }) => {
      return respond(200, { results: [], hasMore: false });
    });
    context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
      return respond(200, { artifacts: [], nextCursor: null });
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const list = await screen.findByTestId("chat-list-column");
    click(within(list).getByLabelText("Search workspace"));

    const dialog = await screen.findByRole("dialog", {
      name: "Search chats, messages, workflows, and artifacts...",
    });

    const rowFor = async (title: string): Promise<HTMLElement> => {
      const row = (await within(dialog).findByText(title)).closest(
        '[role="option"]',
      );
      if (!(row instanceof HTMLElement)) {
        throw new Error(`no spotlight row for ${title}`);
      }
      return row;
    };

    const minutesRow = await rowFor("Minutes old");
    expect(minutesRow).toHaveTextContent("5 minutes ago");
    const hoursRow = await rowFor("Hours old");
    expect(hoursRow).toHaveTextContent("3 hours ago");
    const daysRow = await rowFor("Days old");
    expect(daysRow).toHaveTextContent("2 days ago");

    // Past a month a relative phrase stops helping, so the row shows the
    // absolute date instead. Assert the shape rather than an exact string so
    // the expectation does not depend on the runner's timezone.
    const archived = await rowFor("Older than a month");
    expect(archived).not.toHaveTextContent("ago");
    expect(archived).toHaveTextContent(/[A-Z][a-z]{2} \d{1,2},/u);

    await fill(
      within(dialog).getByPlaceholderText(
        "Search chats, messages, workflows, and artifacts...",
      ),
      "nothing matches this",
    );

    await waitFor(() => {
      expect(within(dialog).getByText("No results found")).toBeInTheDocument();
    });
    expect(within(dialog).queryByText("Minutes old")).not.toBeInTheDocument();
    const emptyState = within(dialog)
      .getByText("No results found")
      .closest("div");
    expect(emptyState?.querySelector("img")).toHaveAttribute(
      "src",
      emptySearchImg,
    );
  });

  it("opens horizontal pinned agent actions from context interactions", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    const researchAgent = await waitFor(() => {
      return pinnedAgentLink(grid, "Research Agent");
    });

    fireEvent.contextMenu(researchAgent);
    expect(menuItemByText("Unpin")).toBeInTheDocument();
    click(menuItemByText("Unpin"));
    await waitFor(() => {
      expect(within(grid).queryByText("Research Agent")).toBeNull();
    });

    const supportAgent = pinnedAgentLink(grid, "Support Agent");
    fireEvent.touchStart(supportAgent, {
      touches: [{ identifier: 1, clientX: 12, clientY: 12 }],
    });
    await waitFor(() => {
      expect(menuItemByText("Unpin")).toBeInTheDocument();
    });
    fireEvent.touchEnd(supportAgent, {
      touches: [],
      changedTouches: [{ identifier: 1, clientX: 12, clientY: 12 }],
    });
    fireEvent.keyDown(document, { code: "Escape", key: "Escape" });
    await waitFor(() => {
      expect(queryMenuItemByText("Unpin")).toBeNull();
    });

    click(supportAgent);
    await waitFor(() => {
      expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
    });
  });

  it("marks all chats read from the three-column chat list menu", async () => {
    prepareDefaultAgent();
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Existing conversation"),
      createThread(INCIDENT_THREAD_ID, "Unread conversation"),
    ]);

    let hasUnread = true;
    const markedAgentIds: string[] = [];
    context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
      return respond(200, {
        agents: hasUnread ? { [AGENT_ID]: "unread" } : {},
        threads: hasUnread ? { [INCIDENT_THREAD_ID]: "unread" } : {},
      });
    });
    context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
      return respond(200, {
        unreads: hasUnread
          ? [
              {
                threadId: INCIDENT_THREAD_ID,
                unreadAt: "2026-03-10T00:05:00Z",
              },
            ]
          : [],
      });
    });
    context.mocks.api(
      chatThreadMarkAgentReadContract.markAgentRead,
      ({ body, respond }) => {
        markedAgentIds.push(body.agentId);
        hasUnread = false;
        return respond(204);
      },
    );

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const list = await screen.findByTestId("chat-list-column");
    await waitFor(() => {
      expect(within(list).getByText("Unread conversation")).toBeInTheDocument();
      expect(within(list).getAllByLabelText("Unread").length).toBeGreaterThan(
        0,
      );
    });

    click(within(list).getByLabelText("Open chat list menu"));
    await waitFor(() => {
      expect(
        queryAllByRoleFast("menuitem").map((item) => {
          return item.textContent?.replace(/\s+/g, " ").trim();
        }),
      ).toStrictEqual([
        "New chat",
        "Mark all read",
        "All chats",
        "Unread only",
      ]);
    });
    click(menuItemByText("Mark all read"));

    await waitFor(() => {
      expect(markedAgentIds).toStrictEqual([AGENT_ID]);
      expect(within(list).queryByLabelText("Unread")).not.toBeInTheDocument();
    });

    click(within(list).getByLabelText("Open chat list menu"));
    expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
  });

  it("creates a new chat thread from the three-column header", async () => {
    prepareDefaultAgent();
    context.mocks.data.userModelPreference({
      selectedModel: null,
      serviceTier: null,
      selectedImageModel: "fal-ai/qwen-image",
      updatedAt: "2026-08-18T00:00:00Z",
    });
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Existing conversation"),
    ]);
    let createdThreadId: string | undefined;
    let createdAgentId: string | undefined;
    let createdImageModel: string | undefined;
    context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
      createdThreadId = body.clientThreadId ?? "created-thread-id";
      createdAgentId = body.agentId;
      createdImageModel = body.imageModel;
      return respond(201, {
        id: createdThreadId,
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
        selectedModel: body.model ?? "claude-sonnet-4-6",
        serviceTier: body.serviceTier ?? null,
      });
    });

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    const list = await screen.findByTestId("chat-list-column");
    const newChatButton = within(list).getByLabelText("New chat");
    await waitFor(() => {
      expect(newChatButton).toBeEnabled();
    });
    click(newChatButton);

    expect(pathname()).not.toBe("/");
    await waitFor(() => {
      expect(createdAgentId).toBe(AGENT_ID);
      // A blank thread pins no image model, so it follows the live member
      // default instead of freezing it at creation time.
      expect(createdImageModel).toBeUndefined();
      expect(createdThreadId).toBeDefined();
      expect(pathname()).toBe(`/chats/${createdThreadId}`);
      expect(within(list).getByText("New chat")).toBeInTheDocument();
    });
    if (!createdThreadId) {
      throw new Error("Created thread id not captured");
    }
    expect(
      context.store.get(eventDrivenChatThread(createdThreadId)),
    ).toMatchObject({ selectedImageModel: null });
  });

  it("ignores a temporary landing image pick when creating a blank thread", async () => {
    prepareDefaultAgent();
    context.mocks.data.userModelPreference({
      selectedModel: null,
      serviceTier: null,
      selectedImageModel: "fal-ai/qwen-image",
      updatedAt: "2026-08-18T00:00:00Z",
    });
    mockSidebarThreadStory([
      createThread(EXISTING_THREAD_ID, "Existing conversation"),
    ]);
    let createdThreadId: string | undefined;
    let createdImageModel: string | undefined;
    context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
      createdThreadId = body.clientThreadId ?? "created-thread-id";
      createdImageModel = body.imageModel;
      return respond(201, {
        id: createdThreadId,
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
        selectedModel: body.model ?? "claude-sonnet-4-6",
        serviceTier: body.serviceTier ?? null,
      });
    });

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    // The user temporarily switched the landing composer image model without
    // pressing "Use this for future chats". A blank thread must not pin that pick; it
    // stays unpinned (null) so it follows the live member default.
    context.store.set(setChatPageImageModelSelection$, "fal-ai/flux-pro/v1.1");

    const list = await screen.findByTestId("chat-list-column");
    const newChatButton = within(list).getByLabelText("New chat");
    await waitFor(() => {
      expect(newChatButton).toBeEnabled();
    });
    click(newChatButton);

    await waitFor(() => {
      expect(createdThreadId).toBeDefined();
    });
    expect(createdImageModel).toBeUndefined();
    if (!createdThreadId) {
      throw new Error("Created thread id not captured");
    }
    expect(
      context.store.get(eventDrivenChatThread(createdThreadId)),
    ).toMatchObject({ selectedImageModel: null });
  });

  it("preserves pinned agent rows across a loading refresh", async () => {
    const pinnedAgentIds = prepareOverflowingPinnedAgents();
    context.mocks.data.userPreferences({ pinnedAgentIds });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const initialGrid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(
        within(initialGrid).getAllByTestId("pinned-agent-card"),
      ).toHaveLength(6);
    });

    cleanup();

    const refreshPinnedAgentIds =
      prepareOverflowingPinnedAgents(refreshContext);
    const preferencesGate = refreshContext.mocks.deferred<void>();
    refreshContext.mocks.api(
      userPreferencesContract.get,
      async ({ respond }) => {
        await preferencesGate.promise;
        return respond(200, {
          timezone: null,
          locale: null,
          supportedLocales: [
            "en-US",
            "pt-BR",
            "ja-JP",
            "ko-KR",
            "id-ID",
            "de-DE",
            "es-ES",
            "it-IT",
            "fr-FR",
            "hi-IN",
          ],
          pinnedAgentIds: refreshPinnedAgentIds,
          sendMode: "enter",
          morningBriefEnabled: false,
          morningBriefNextRunAt: null,
          captureNetworkBodiesRemaining: 0,
        });
      },
    );

    setupSidebarPage({
      context: refreshContext,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    // Six cards plus Pin cached two rows, so the skeleton grid must restore
    // 2 * 5 - 1 placeholders rather than the single-row default of 4.
    expect(within(grid).getAllByTestId("pinned-agent-skeleton")).toHaveLength(
      9,
    );

    preferencesGate.resolve();

    await waitFor(() => {
      expect(within(grid).queryByTestId("pinned-agent-skeleton")).toBeNull();
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    });
  });

  it("keeps Pin after the first four pinned agents in navigation order", async () => {
    const pinnedAgentIds = prepareOverflowingPinnedAgents();
    context.mocks.data.userPreferences({ pinnedAgentIds });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const pinnedSection = await screen.findByTestId("pinned-agents-horizontal");
    const grid = within(pinnedSection).getByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    });

    const pinAgent = queryAllByRoleFast("button", grid).find((candidate) => {
      return candidate.getAttribute("aria-label") === "Pin an agent";
    });
    if (!pinAgent) {
      throw new Error("Pin agent button not found");
    }
    // Cards render as Zero, Research, Support, Operations, Pin, Analytics,
    // Billing, so Pin closes the first row and the rest wrap after it.
    const fourthAgent = pinnedAgentLink(grid, "Operations Agent");
    const fifthAgent = pinnedAgentLink(grid, "Analytics Agent");

    expect(fourthAgent).toHaveAttribute("title", "Operations Agent");
    expect(fifthAgent).toHaveAttribute("title", "Analytics Agent");

    expect(
      fourthAgent.compareDocumentPosition(pinAgent) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      pinAgent.compareDocumentPosition(fifthAgent) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("keeps the pin dialog open and confirms a row pin", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({ pinnedAgentIds: [RESEARCH_AGENT_ID] });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(2);
    });

    click(screen.getByLabelText("Pin an agent"));

    const dialogList = await screen.findByTestId("pin-agent-dialog-list");
    const pinnedOption = commandItemByText(dialogList, "Research Agent");
    expect(pinnedOption.getAttribute("aria-disabled")).not.toBe("true");

    click(commandItemByText(dialogList, "Support Agent"));

    await expect(
      screen.findByText("Support Agent pinned"),
    ).resolves.toBeInTheDocument();
    await waitFor(() => {
      expect(pinnedAgentNames(grid)).toStrictEqual([
        "Zero",
        "Research Agent",
        "Support Agent",
      ]);
    });
    expect(dialogList).toBeInTheDocument();
    expect(
      buttonByText("Unpin", commandItemByText(dialogList, "Support Agent")),
    ).toBeInTheDocument();
    click(screen.getByLabelText("Close"));
    await waitFor(() => {
      expect(screen.queryByTestId("pin-agent-dialog-list")).toBeNull();
    });
    expect(pinnedAgentLink(grid, "Support Agent")).toBeInTheDocument();
  });

  it("keeps the pin dialog open and confirms an unpin", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({
      pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(3);
    });

    click(screen.getByLabelText("Pin an agent"));

    const dialogList = await screen.findByTestId("pin-agent-dialog-list");
    const pinnedRow = commandItemByText(dialogList, "Support Agent");
    click(buttonByText("Unpin", pinnedRow));

    await waitFor(() => {
      expect(pinnedAgentNames(grid)).toStrictEqual(["Zero", "Research Agent"]);
    });
    expect(dialogList).toBeInTheDocument();
    expect(
      buttonByText("Pin", commandItemByText(dialogList, "Support Agent")),
    ).toBeInTheDocument();
    await expect(
      screen.findByText("Support Agent unpinned"),
    ).resolves.toBeInTheDocument();
  });

  it("keeps the pin dialog open after its row action pins an agent", async () => {
    prepareAgents();
    context.mocks.data.userPreferences({ pinnedAgentIds: [] });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(1);
    });

    click(screen.getByLabelText("Pin an agent"));

    const dialogList = await screen.findByTestId("pin-agent-dialog-list");
    const unpinnedRow = commandItemByText(dialogList, "Support Agent");
    click(buttonByText("Pin", unpinnedRow));

    await waitFor(() => {
      expect(pinnedAgentNames(grid)).toStrictEqual(["Zero", "Support Agent"]);
    });
    expect(dialogList).toBeInTheDocument();
    expect(
      buttonByText("Unpin", commandItemByText(dialogList, "Support Agent")),
    ).toBeInTheDocument();
    await expect(
      screen.findByText("Support Agent pinned"),
    ).resolves.toBeInTheDocument();
  });

  it("reorders pinned agents without retaining the browser link payload", async () => {
    const pinnedAgentIds = prepareOverflowingPinnedAgents();
    context.mocks.data.userPreferences({ pinnedAgentIds });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    });
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Zero",
      "Research Agent",
      "Support Agent",
      "Operations Agent",
      "Analytics Agent",
      "Billing Agent",
    ]);

    const dragged = pinnedAgentLink(grid, "Support Agent");
    const target = pinnedAgentLink(grid, "Billing Agent");
    const dataTransfer = createDataTransferStub({
      "text/uri-list": dragged.href,
      "text/plain": dragged.href,
    });
    fireEvent.dragStart(dragged, { dataTransfer });
    expect(dataTransfer.getData("text/uri-list")).toBe("");
    expect(dataTransfer.getData("text/plain")).toBe("");
    expect(dataTransfer.getData("application/x-okou-pinned-agent")).toBe(
      SUPPORT_AGENT_ID,
    );
    fireEvent.dragOver(target, { dataTransfer });
    fireEvent.drop(target, { dataTransfer });

    await waitFor(() => {
      expect(pinnedAgentNames(grid)).toStrictEqual([
        "Zero",
        "Research Agent",
        "Operations Agent",
        "Analytics Agent",
        "Billing Agent",
        "Support Agent",
      ]);
    });
  });

  it("shows drag handles only while a reorder drag is in flight", async () => {
    const pinnedAgentIds = prepareOverflowingPinnedAgents();
    context.mocks.data.userPreferences({ pinnedAgentIds });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    });

    expect(
      within(grid).queryAllByTestId("pinned-agent-drag-handle"),
    ).toHaveLength(0);

    fireEvent.dragStart(pinnedAgentLink(grid, "Support Agent"), {
      dataTransfer: createDataTransferStub(),
    });

    expect(
      within(pinnedAgentLink(grid, "Operations Agent")).getByTestId(
        "pinned-agent-drag-handle",
      ),
    ).toBeInTheDocument();
    expect(
      within(pinnedAgentLink(grid, "Support Agent")).queryByTestId(
        "pinned-agent-drag-handle",
      ),
    ).toBeNull();
    expect(
      within(pinnedAgentLink(grid, "Zero")).queryByTestId(
        "pinned-agent-drag-handle",
      ),
    ).toBeNull();
  });

  it("marks the landing slot with an insertion caret while dragging", async () => {
    const pinnedAgentIds = prepareOverflowingPinnedAgents();
    context.mocks.data.userPreferences({ pinnedAgentIds });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    });

    // Billing Agent sits after Support Agent, so a forwards drag lands after it.
    const forwards = createDataTransferStub();
    fireEvent.dragStart(pinnedAgentLink(grid, "Support Agent"), {
      dataTransfer: forwards,
    });
    fireEvent.dragOver(pinnedAgentLink(grid, "Billing Agent"), {
      dataTransfer: forwards,
    });

    await waitFor(() => {
      expect(
        within(grid).getAllByTestId("pinned-agent-drop-caret"),
      ).toHaveLength(1);
    });
    expect(
      within(pinnedAgentLink(grid, "Billing Agent")).getByTestId(
        "pinned-agent-drop-caret",
      ).className,
    ).toContain("-right-");

    fireEvent.dragEnd(pinnedAgentLink(grid, "Support Agent"), {
      dataTransfer: forwards,
    });
    await waitFor(() => {
      expect(
        within(grid).queryAllByTestId("pinned-agent-drop-caret"),
      ).toHaveLength(0);
    });

    // Research Agent sits before Support Agent, so a backwards drag lands before it.
    const backwards = createDataTransferStub();
    fireEvent.dragStart(pinnedAgentLink(grid, "Support Agent"), {
      dataTransfer: backwards,
    });
    fireEvent.dragOver(pinnedAgentLink(grid, "Research Agent"), {
      dataTransfer: backwards,
    });

    await waitFor(() => {
      expect(
        within(pinnedAgentLink(grid, "Research Agent")).getByTestId(
          "pinned-agent-drop-caret",
        ).className,
      ).toContain("-left-");
    });
  });

  it("leaves the lead agent in place when it is dragged", async () => {
    const pinnedAgentIds = prepareOverflowingPinnedAgents();
    context.mocks.data.userPreferences({ pinnedAgentIds });
    const savedPinnedOrders: string[][] = [];
    let storedPinnedAgentIds = [...pinnedAgentIds];
    context.mocks.api(userPreferencesContract.update, ({ body, respond }) => {
      // Boot also writes unrelated preferences such as the timezone, so only a
      // request that carries pinned ids counts as a reorder.
      if (body.pinnedAgentIds !== undefined) {
        storedPinnedAgentIds = [...body.pinnedAgentIds];
        savedPinnedOrders.push([...body.pinnedAgentIds]);
      }
      const nextPinnedAgentIds = storedPinnedAgentIds;
      context.mocks.data.userPreferences({
        pinnedAgentIds: [...nextPinnedAgentIds],
      });
      return respond(200, {
        timezone: null,
        locale: null,
        supportedLocales: [
          "en-US",
          "pt-BR",
          "ja-JP",
          "ko-KR",
          "id-ID",
          "de-DE",
          "es-ES",
          "it-IT",
          "fr-FR",
          "hi-IN",
        ],
        pinnedAgentIds: [...nextPinnedAgentIds],
        sendMode: "enter",
        morningBriefEnabled: false,
        morningBriefNextRunAt: null,
        captureNetworkBodiesRemaining: 0,
      });
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const grid = await screen.findByTestId("pinned-agents-grid");
    await waitFor(() => {
      expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    });

    const leadDragTransfer = createDataTransferStub();
    const lead = pinnedAgentLink(grid, "Zero");
    fireEvent.dragStart(pinnedAgentLink(grid, "Support Agent"), {
      dataTransfer: leadDragTransfer,
    });
    expect(
      fireEvent.dragOver(lead, { dataTransfer: leadDragTransfer }),
    ).toBeFalsy();
    expect(
      fireEvent.drop(lead, { dataTransfer: leadDragTransfer }),
    ).toBeFalsy();
    fireEvent.dragEnd(pinnedAgentLink(grid, "Support Agent"), {
      dataTransfer: leadDragTransfer,
    });

    // A later reorder gives the lead drop time to land if it were not a no-op,
    // so the recorded requests below prove it never reached the API.
    const reorderTransfer = createDataTransferStub();
    fireEvent.dragStart(pinnedAgentLink(grid, "Support Agent"), {
      dataTransfer: reorderTransfer,
    });
    fireEvent.dragOver(pinnedAgentLink(grid, "Billing Agent"), {
      dataTransfer: reorderTransfer,
    });
    fireEvent.drop(pinnedAgentLink(grid, "Billing Agent"), {
      dataTransfer: reorderTransfer,
    });

    await waitFor(() => {
      expect(pinnedAgentNames(grid)).toStrictEqual([
        "Zero",
        "Research Agent",
        "Operations Agent",
        "Analytics Agent",
        "Billing Agent",
        "Support Agent",
      ]);
    });
    expect(savedPinnedOrders).toStrictEqual([
      [
        RESEARCH_AGENT_ID,
        OVERFLOW_PINNED_AGENTS[0].agentId,
        OVERFLOW_PINNED_AGENTS[1].agentId,
        OVERFLOW_PINNED_AGENTS[2].agentId,
        SUPPORT_AGENT_ID,
      ],
    ]);
    expect(pinnedAgentLink(grid, "Zero")).toBeInTheDocument();
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
    });

    const rail = await screen.findByTestId("labeled-nav-rail");
    expect(
      within(rail).getByRole("navigation", { name: "Barra lateral" }),
    ).toBeInTheDocument();
    expect(within(rail).getByText("Agentes")).toBeInTheDocument();
    const workflowsLink = within(rail).getByLabelText("Fluxos de trabalho");
    expect(workflowsLink).toHaveAttribute("title", "Fluxos de trabalho");
    expect(within(rail).getByText("Conectores")).toBeInTheDocument();
    expect(within(rail).getByText("Artefatos")).toBeInTheDocument();
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

  it("localizes desktop and mobile shell navigation in Japanese", async () => {
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
      locale: "ja-JP",
      supportedLocales: ["en-US", "ja-JP"],
    });

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    const rail = await screen.findByTestId("labeled-nav-rail");
    expect(
      within(rail).getByRole("navigation", { name: "サイドバー" }),
    ).toBeInTheDocument();
    expect(within(rail).getByText("エージェント")).toBeInTheDocument();
    expect(within(rail).getByText("ワークフロー")).toBeInTheDocument();
    expect(within(rail).getByText("コネクター")).toBeInTheDocument();
    expect(within(rail).getByText("アーティファクト")).toBeInTheDocument();
    expect(within(rail).getByLabelText("Zeroの連携先")).toBeInTheDocument();
    expect(screen.getByLabelText("メニューを開く")).toBeInTheDocument();
    expect(
      screen.getByLabelText("モバイルでアーティファクトを開く"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("モバイルでオートメーションを開く"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("サイドバーを折りたたむ")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    const dialog = await screen.findByRole("dialog", {
      name: "キーボードショートカット",
    });
    expect(
      within(dialog).getByText("このページで利用可能なショートカット"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("ショートカットを表示する"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("キーボードショートカットを閉じる"),
    ).toBeInTheDocument();
  });

  it("localizes desktop and mobile shell navigation in Spanish", async () => {
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
      locale: "es-ES",
      supportedLocales: ["en-US", "es-ES"],
    });

    setupSidebarPage({
      context,
      path: `/chats/${EXISTING_THREAD_ID}`,
    });

    const rail = await screen.findByTestId("labeled-nav-rail");
    expect(
      within(rail).getByRole("navigation", { name: "Barra lateral" }),
    ).toBeInTheDocument();
    expect(within(rail).getByText("Agentes")).toBeInTheDocument();
    expect(within(rail).getByText("Flujos de trabajo")).toBeInTheDocument();
    expect(within(rail).getByText("Conectores")).toBeInTheDocument();
    expect(within(rail).getByText("Artefactos")).toBeInTheDocument();
    expect(
      within(rail).getByLabelText("Dónde trabaja Zero"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Abrir menú")).toBeInTheDocument();
    expect(
      screen.getByLabelText("Abrir artefactos en móvil"),
    ).toBeInTheDocument();
    expect(
      screen.getByLabelText("Abrir automatizaciones en móvil"),
    ).toBeInTheDocument();
    expect(screen.getByLabelText("Contraer barra lateral")).toBeInTheDocument();

    fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

    const dialog = await screen.findByRole("dialog", {
      name: "Atajos de teclado",
    });
    expect(
      within(dialog).getByText("Atajos disponibles en esta página"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByText("Mostrar atajos de teclado"),
    ).toBeInTheDocument();
    expect(
      within(dialog).getByLabelText("Cerrar atajos de teclado"),
    ).toBeInTheDocument();
  });

  it("keeps localized navigation accessible while hiding and showing the chat list", async () => {
    prepareDefaultAgent();
    context.mocks.data.userPreferences({
      locale: "pt-BR",
      supportedLocales: ["en-US", "pt-BR"],
    });

    setupSidebarPage({
      context,
      path: `/agents/${AGENT_ID}/chat`,
    });

    const list = await screen.findByTestId("chat-list-column");
    click(within(list).getByLabelText("Ocultar lista de conversas"));

    const rail = await screen.findByTestId("labeled-nav-rail");
    expect(
      within(rail).getByRole("navigation", { name: "Barra lateral" }),
    ).toBeInTheDocument();
    expect(within(rail).getByLabelText("Agentes")).toBeInTheDocument();

    click(within(rail).getByLabelText("Mostrar lista de conversas"));
    await screen.findByTestId("chat-list-column");
  });
});
