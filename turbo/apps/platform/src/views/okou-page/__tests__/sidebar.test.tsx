import {
  act,
  fireEvent,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { expect, test, vi } from "vitest";

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
import { browserContract } from "@okouai/api-contracts/contracts/browser";
import {
  agentsByIdContract,
  type AgentResponse,
} from "@okouai/api-contracts/contracts/agents";
import { FeatureSwitchKey } from "@okouai/core/feature-switch-key";
import { artifactCatalogContract } from "@okouai/api-contracts/contracts/artifact-catalog";
import {
  billingStatusContract,
  type BillingStatusResponse,
} from "@okouai/api-contracts/contracts/billing";
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
  setupPage,
  fill,
  holdElementAnimations,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockNow } from "../../../__tests__/time.ts";
import { emptySearchImg } from "../platform-assets.ts";
import {
  testContext,
  chatEventRowsResponse,
} from "../../../signals/__tests__/test-helpers.ts";
import { pathname, search } from "../../../signals/location.ts";
import { setChatPageImageModelSelection$ } from "../../../signals/okou-page/chat-page.ts";
import { PLACEHOLDER } from "./chat-test-helpers.ts";
import { mockChatEventRows } from "./chat-event-test-helpers.ts";
import {
  changeChatThreadList,
  changeChatThreadReadCursor,
} from "../../../mocks/mock-helpers.ts";

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

function prepareDefaultAgent(targetContext = context): void {
  targetContext.mocks.data.agents([
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

function topTierBillingStatus(): BillingStatusResponse {
  return {
    tier: "team",
    credits: 100,
    onboardingPaymentPending: false,
    subscriptionStatus: "active",
    currentPeriodEnd: null,
    cancelAtPeriodEnd: false,
    scheduledChange: null,
    hasSubscription: true,
    autoRecharge: { enabled: false, threshold: null, amount: null },
    creditExpiry: { expiringNextCycle: 0, nextExpiryDate: null },
    creditBreakdown: [],
    creditGrants: [],
    concurrencyLimit: 1,
    concurrencySubscriptions: [],
  };
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
  const templateAgent = agents[1];
  if (!templateAgent) {
    throw new Error("Pinned-agent template is unavailable");
  }
  targetContext.mocks.data.agents([
    ...agents,
    ...OVERFLOW_PINNED_AGENTS.map((agent) => {
      return {
        ...templateAgent,
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
  targetContext = context,
): { readonly responseReturned: Promise<void> } {
  const responseReturned = targetContext.mocks.deferred<void>();
  targetContext.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    const snapshotThreads = threads();
    const response = respond(200, {
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
    responseReturned.resolve();
    return response;
  });
  targetContext.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  targetContext.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: {},
      threads: Object.fromEntries(
        activeThreadIds().map((threadId) => {
          return [threadId, "active" as const];
        }),
      ),
    });
  });
  return { responseReturned: responseReturned.promise };
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

function queryMobileSidebar(): HTMLElement | null {
  const drawer = document.querySelector("aside.zero-pwa-fixed-cover");
  return drawer instanceof HTMLElement ? drawer : null;
}

function mobileSidebar(): HTMLElement {
  const drawer = queryMobileSidebar();
  if (!drawer) {
    throw new Error("Mobile sidebar not found");
  }
  return drawer;
}

function mockMobileLayout() {
  return context.mocks.browser.matchMedia(false);
}

function mockDesktopLayout() {
  return context.mocks.browser.matchMedia((query) => {
    return query === "(min-width: 48rem)";
  });
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
  options: Parameters<typeof setupPage>[0],
): Promise<void> {
  return setupPage(options);
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

function threadRowByTitle(
  title: string,
  container: HTMLElement = sidebar(),
): HTMLElement {
  const link = threadLinkByTitle(title, container);
  const row = link.parentElement;
  if (!row) {
    throw new Error(`${title} thread row not found`);
  }
  return row;
}

function threadLinkByTitle(
  title: string,
  container: HTMLElement = sidebar(),
): HTMLElement {
  const link = queryAllByRoleFast("link", container).find((candidate) => {
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

function openThreadMenu(title: string): void {
  click(
    within(threadRowByTitle(title)).getByTestId("chat-thread-menu-trigger"),
  );
}

function openChatListMenu(): void {
  click(within(sidebar()).getByLabelText("Open chat list menu"));
}

function chatListNewChatButton(): HTMLElement {
  const menuButton = within(sidebar()).getByLabelText("Open chat list menu");
  const actions = menuButton.parentElement;
  if (!actions) {
    throw new Error("Chat list actions not found");
  }
  return within(actions).getByLabelText("New chat");
}

function mockSidebarThreadStory(
  firstPageThreads: SidebarThread[],
  extraThreads: SidebarThread[] = [],
  activeThreadIds: readonly string[] = [],
  targetContext = context,
): {
  threads: SidebarThread[];
  snapshotResponseReturned: Promise<void>;
} {
  let threads = [...firstPageThreads];

  const { responseReturned: snapshotResponseReturned } = mockChatThreadSnapshot(
    () => {
      return [...threads, ...extraThreads];
    },
    () => {
      return activeThreadIds;
    },
    targetContext,
  );

  targetContext.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
      cancellationRecoveryPending: false,
    });
  });
  targetContext.mocks.api(chatThreadPinContract.pin, ({ params, respond }) => {
    threads = threads.map((thread) => {
      return thread.id === params.id
        ? { ...thread, pinnedAt: "2026-03-10T12:00:00Z" }
        : thread;
    });
    return respond(204);
  });
  targetContext.mocks.api(
    chatThreadUnpinContract.unpin,
    ({ params, respond }) => {
      threads = threads.map((thread) => {
        return thread.id === params.id ? { ...thread, pinnedAt: null } : thread;
      });
      return respond(204);
    },
  );
  targetContext.mocks.api(
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
  targetContext.mocks.api(
    chatThreadByIdContract.delete,
    ({ params, respond }) => {
      threads = threads.filter((thread) => {
        return thread.id !== params.id;
      });
      return respond(204);
    },
  );

  return { threads, snapshotResponseReturned };
}

test("Browse a long sidebar chat history", async () => {
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
    [...overflowThreads, createThread(ARCHIVED_THREAD_ID, "Archived context")],
  );

  await setupSidebarPage({
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
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
  });
  expect(within(sidebar()).queryByText("Release plan")).toBeNull();
  expect(within(sidebar()).queryByText("Load more")).not.toBeInTheDocument();

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

test("Drag the sidebar scrollbar when enabled", async () => {
  prepareDefaultAgent();
  context.mocks.browser.noAnimations();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.BaseUiSidebarScrollArea]: true,
    },
  });

  const scrollArea = await waitFor(() => {
    const current = within(sidebar()).getByTestId("sidebar-scroll-area");
    expect(current).toBeInTheDocument();
    return current;
  });
  Object.defineProperties(scrollArea, {
    clientHeight: { configurable: true, value: 200 },
    clientWidth: { configurable: true, value: 200 },
    scrollHeight: { configurable: true, value: 1000 },
    scrollTop: { configurable: true, value: 0, writable: true },
    scrollWidth: { configurable: true, value: 200 },
  });
  scrollArea.style.scrollSnapType = "y mandatory";
  fireEvent.scroll(scrollArea);

  const scrollbar = await screen.findByTestId("sidebar-scrollbar");
  const thumb = await screen.findByTestId("sidebar-scrollbar-thumb");
  // The thumb sits against the viewport's edge rather than centred in the
  // track. Beside the workspace card the chat list keeps only four pixels of
  // right inset, and a centred thumb lands on the trailing menu button of the
  // row it is scrolling past.
  expect(scrollbar).toHaveClass("justify-end");
  scrollbar.style.paddingBlockStart = "0px";
  scrollbar.style.paddingBlockEnd = "0px";
  thumb.style.marginBlockStart = "0px";
  thumb.style.marginBlockEnd = "0px";
  Object.defineProperty(scrollbar, "offsetHeight", {
    configurable: true,
    value: 200,
  });
  Object.defineProperty(thumb, "offsetHeight", {
    configurable: true,
    value: 40,
  });

  let capturedPointerId: number | null = null;
  Object.defineProperties(thumb, {
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        return capturedPointerId === pointerId;
      },
    },
    releasePointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        if (capturedPointerId === pointerId) {
          capturedPointerId = null;
        }
      },
    },
    setPointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        capturedPointerId = pointerId;
      },
    },
  });

  fireEvent.pointerDown(thumb, {
    button: 0,
    buttons: 1,
    clientY: 20,
    pointerId: 1,
  });
  expect(scrollArea.style.scrollSnapType).toBe("none");

  fireEvent.pointerMove(thumb, {
    buttons: 1,
    clientY: 100,
    pointerId: 1,
  });
  expect(scrollArea.scrollTop).toBe(400);

  fireEvent.pointerUp(thumb, {
    button: 0,
    buttons: 0,
    clientY: 100,
    pointerId: 1,
  });
  expect(scrollArea.style.scrollSnapType).toBe("y mandatory");
});

test("Collapse and expand Manage navigation", async () => {
  mockMobileLayout();
  prepareDefaultAgent();

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

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
  // The track hugs the viewport's edge for the same reason the Base UI thumb
  // does: beside the workspace card the chat list keeps only four pixels of
  // right inset, and anything further in overlaps the row's trailing menu
  // button.
  expect(scrollbarTrack).toHaveClass("right-px");
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

test("Combine chat-title and message results in workspace search", async () => {
  mockMobileLayout();
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
        };
      }),
      hasMore: false,
    });
  });

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search chats, messages, workflows, and artifacts...",
  });
  await fill(
    within(dialog).getByPlaceholderText(
      "Search chats, messages, workflows, and artifacts...",
    ),
    "deploy",
  );

  await waitFor(() => {
    expect(requestedKeyword).toBe("deploy");
    expect(within(dialog).getByText("Deployment notes")).toBeInTheDocument();
    expect(within(dialog).getByText("Deployment archive")).toBeInTheDocument();
    expect(within(dialog).getByText("Searching...")).toBeInTheDocument();
  });

  searchResponse.resolve();

  await waitFor(() => {
    expect(within(dialog).queryByText("Searching...")).not.toBeInTheDocument();
    expect(within(dialog).getByText("28 results")).toBeInTheDocument();
  });
  const [highlighted] = within(dialog).getAllByText("deploy");
  if (!highlighted) {
    throw new Error("Highlighted message search term not found");
  }
  expect(highlighted).toHaveClass("text-foreground");

  const results = within(dialog).getAllByRole("option");
  expect(results).toHaveLength(28);
  expect(results[0]).toHaveTextContent("Deployment notes");
  expect(results[1]).toHaveTextContent("Deployment follow-up");
  expect(results[2]).toHaveTextContent("Deployment archive");
  expect(results[3]).toHaveTextContent(
    "Production deploy 1 finished successfully",
  );
  expect(within(dialog).queryByText("Deploy alpha")).not.toBeInTheDocument();
  const messageResult = highlighted.closest('[role="option"]');
  if (!(messageResult instanceof HTMLElement)) {
    throw new Error("Message search result not found");
  }
  click(messageResult);

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search chats, messages, workflows, and artifacts...",
      }),
    ).not.toBeInTheDocument();
    expect(document.title).toBe("Deployment notes | VM0");
  });
});

test("Create a new chat without hiding existing conversations", async () => {
  prepareDefaultAgent();
  context.mocks.data.userModelPreference({
    selectedModel: null,
    serviceTier: null,
    selectedImageModel: "fal-ai/qwen-image",
    updatedAt: "2026-08-18T00:00:00Z",
  });
  const createDeferred = context.mocks.deferred<void>();
  let createdImageModel: string | undefined;
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
    createdImageModel = body.imageModel;
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

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const newChatButton = await waitFor(() => {
    expect(
      visibleThreadTitles([
        "A server first",
        "B server second",
        "C server third",
      ]),
    ).toStrictEqual(["A server first", "B server second", "C server third"]);
    return chatListNewChatButton();
  });

  context.store.set(setChatPageImageModelSelection$, "fal-ai/flux-pro/v1.1");

  click(newChatButton);

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
    expect(createdImageModel).toBeUndefined();
  });

  createDeferred.resolve();
});

test("Delete a chat after reviewing the impact", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);

  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

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

test("Filter the chat list to unread conversations", async () => {
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

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
  });

  openChatListMenu();
  click(menuItemByText("Unread only"));

  await waitFor(() => {
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

test("Find conversations by title in workspace search", async () => {
  prepareAgents();
  const defaultThread = createThread(EXISTING_THREAD_ID, "Incident notes");
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });
  const supportThread = createThread(INCIDENT_THREAD_ID, "Support escalation", {
    agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
  });
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

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search chats, messages, workflows, and artifacts...",
  });
  const search = within(dialog).getByPlaceholderText(
    "Search chats, messages, workflows, and artifacts...",
  );

  await fill(search, "research");

  await waitFor(() => {
    expect(within(dialog).getByText("Research kickoff")).toBeInTheDocument();
    expect(
      within(dialog).queryByText("Support escalation"),
    ).not.toBeInTheDocument();
  });

  await fill(search, "support");
  await waitFor(() => {
    expect(
      within(agentRowByName(dialog, "Support escalation")).getByLabelText(
        "Running",
      ),
    ).toBeInTheDocument();
  });
  click(within(dialog).getByText("Support escalation"));

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search chats, messages, workflows, and artifacts...",
      }),
    ).not.toBeInTheDocument();
    expect(document.title).toBe("Support escalation | VM0");
  });
});

test("Focus the current chat from the thread list", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(AUTOMATION_THREAD_ID, "Scheduled launch"),
  ]);

  await setupSidebarPage({
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
  const currentLink = threadLinkByTitle("Release plan");
  expect(currentLink).toHaveClass("focus-visible:outline-none");
  expect(currentLink).toHaveClass("focus-visible:ring-2");
  expect(currentLink).toHaveClass("focus-visible:ring-inset");
  expect(currentLink).toHaveClass("focus-visible:ring-ring");
  expect(threadLinkByTitle("Incident notes")).not.toHaveFocus();
});

test("Hide and show the chat list without losing workspace search", async () => {
  prepareDefaultAgent();

  await setupSidebarPage({
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
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
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

test("Keep chat navigation usable while secondary data is unavailable", async () => {
  prepareDefaultAgent();
  const indicatorResponse = context.mocks.deferred<void>();
  const draftResponse = context.mocks.deferred<void>();
  const draftRequestStarted = context.mocks.deferred<void>();
  const draftResponseReturned = context.mocks.deferred<void>();
  const indicatorRequestStarted = context.mocks.deferred<void>();

  const { snapshotResponseReturned } = mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Existing conversation"),
  ]);
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    indicatorRequestStarted.resolve();
    await indicatorResponse.promise;
    return respond(200, { agents: {}, threads: {} });
  });
  context.mocks.api(chatThreadsContract.drafts, async ({ respond }) => {
    draftRequestStarted.resolve();
    await draftResponse.promise;
    const response = respond(401, {
      error: {
        code: "UNAUTHORIZED",
        message: "Draft membership unavailable",
      },
    });
    draftResponseReturned.resolve();
    return response;
  });

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });
  await Promise.all([
    snapshotResponseReturned,
    indicatorRequestStarted.promise,
  ]);

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Existing conversation"),
    ).toBeInTheDocument();
    expect(
      sidebar().querySelectorAll('[data-testid="sidebar-skeleton"]'),
    ).toHaveLength(0);
  });
  expect(
    within(threadRowByTitle("Existing conversation")).queryByLabelText(
      "Running",
    ),
  ).not.toBeInTheDocument();

  indicatorResponse.resolve();
  await draftRequestStarted.promise;
  draftResponse.resolve();
  await draftResponseReturned.promise;
  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Existing conversation"),
    ).toBeInTheDocument();
  });
  expect(chatListNewChatButton()).toBeInTheDocument();
  openChatListMenu();
  expect(queryMenuItemByText("New chat")).not.toBeInTheDocument();
  expect(menuItemByText("All chats")).toBeInTheDocument();
  expect(menuItemByText("Unread only")).toBeInTheDocument();
});

test("Mount only the sidebar for the current viewport", async () => {
  prepareDefaultAgent();
  const mediaQuery = mockMobileLayout();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  expect(screen.getByLabelText("Open menu")).toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);

  act(() => {
    mediaQuery.setMatches(true);
  });

  await waitFor(() => {
    expect(screen.getByTestId("labeled-nav-rail")).toBeInTheDocument();
    expect(screen.getByTestId("chat-list-column")).toBeInTheDocument();
  });
  expect(queryMobileSidebar()).not.toBeInTheDocument();
  expect(screen.queryByLabelText("Open menu")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);

  act(() => {
    mediaQuery.setMatches(false);
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("labeled-nav-rail")).not.toBeInTheDocument();
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();
  expect(screen.getAllByTestId("sidebar-scroll-area")).toHaveLength(1);
});

test("Keep pin management usable with many pinned agents", async () => {
  const pinnedAgentIds = prepareOverflowingPinnedAgents();
  const preferencesGate = context.mocks.deferred<void>();
  context.mocks.api(userPreferencesContract.get, async ({ respond }) => {
    await preferencesGate.promise;
    return respond(200, {
      timezone: null,
      locale: null,
      translationLanguage: null,
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
      pinnedAgentIds,
      sendMode: "enter",
      cloudBrowserEnabledByDefault: true,
      theme: "system",
      colorTheme: "blue-horizon",
      captureNetworkBodiesRemaining: 0,
    });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const pinnedSection = await screen.findByTestId("pinned-agents-horizontal");
  const grid = within(pinnedSection).getByTestId("pinned-agents-grid");
  expect(within(pinnedSection).getByText("Pinned agents")).toBeVisible();
  expect(within(grid).getAllByTestId("pinned-agent-skeleton")).toHaveLength(1);
  expect(within(grid).queryByTestId("pinned-agent-card")).toBeNull();
  expect(within(grid).queryByLabelText("Pin an agent")).toBeNull();

  preferencesGate.resolve();

  await waitFor(() => {
    expect(within(grid).queryByTestId("pinned-agent-skeleton")).toBeNull();
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(6);
    expect(buttonByLabel("Pin an agent", grid)).toBeVisible();
  });
  expect(
    queryAllByRoleFast("link", grid).map((link) => {
      return link.textContent?.trim();
    }),
  ).toStrictEqual([
    "Zero",
    "Research Agent",
    "Support Agent",
    "Operations Agent",
    "Analytics Agent",
    "Billing Agent",
  ]);

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

  expect(
    fourthAgent.compareDocumentPosition(pinAgent) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  expect(
    pinAgent.compareDocumentPosition(fifthAgent) &
      Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
});

test("Keep pinned agents and the chat heading visible while conversations scroll", async () => {
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
    [...overflowThreads, createThread(ARCHIVED_THREAD_ID, "Archived context")],
  );

  await setupSidebarPage({
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
    expect(within(sidebar()).getByText("Archived context")).toBeInTheDocument();
  });
});

// The new shell parks the workspace card's eight-pixel gutter, painted in the
// sidebar colour, immediately right of this column. Keeping the full inset here
// as well stacks the two, so the rows sit twice as far from the card's border
// as from the rail.
test("Spend the workspace card's gutter out of the chat list's right inset", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([createThread(EXISTING_THREAD_ID, "Release plan")]);

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.NewUi]: true,
    },
  });

  await waitFor(() => {
    return within(sidebar()).getByText("Chats with Zero");
  });

  const pinnedContent = within(sidebar()).getByTestId(
    "pinned-agents-horizontal",
  ).parentElement;
  const threadContent =
    within(sidebar()).getByText("Chats with Zero").parentElement?.parentElement;
  const header = sidebar().firstElementChild;
  const footer = sidebar().lastElementChild;
  if (
    !(pinnedContent instanceof HTMLElement) ||
    !(threadContent instanceof HTMLElement) ||
    !(header instanceof HTMLElement) ||
    !(footer instanceof HTMLElement)
  ) {
    throw new Error("Chat list column frame not found");
  }

  // The rail on the other side supplies no such gutter, so the left inset is
  // unchanged and the two edges only read alike once the right one hands its
  // eight pixels to the card.
  for (const element of [header, pinnedContent, threadContent, footer]) {
    expect(element).toHaveClass("pl-3", "pr-1");
    expect(element).not.toHaveClass("px-3");
  }
});

test("Route New chat to the current agent and Chat to the default agent", async () => {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Research conversation", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  const rail = await screen.findByTestId("labeled-nav-rail");
  await screen.findByPlaceholderText(PLACEHOLDER);
  expect(
    within(screen.getByTestId("chat-list-column")).getByText(
      "Research conversation",
    ),
  ).toBeInTheDocument();
  await screen.findByText("Chats with Research Agent");

  const list = screen.getByTestId("chat-list-column");
  const searchButton = within(list).getByLabelText("Search workspace");
  if (!searchButton.parentElement) {
    throw new Error("Chat header not found");
  }
  click(within(searchButton.parentElement).getByLabelText("New chat"));

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${RESEARCH_AGENT_ID}/chat`);
  });

  const chatLink = within(rail).getByLabelText("Chat");
  expect(chatLink).toHaveAttribute("href", `/agents/${AGENT_ID}/chat`);
  click(chatLink);

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${AGENT_ID}/chat`);
    expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
  });
});

test("Localize mobile agent navigation", async () => {
  mockMobileLayout();
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    locale: "pt-BR",
  });

  const nav = await waitFor(() => {
    const drawer = mobileSidebar();
    expect(within(drawer).getByText("Agentes")).toBeInTheDocument();
    return drawer;
  });

  expect(within(nav).getByText("Fixados")).toBeInTheDocument();
  expect(within(nav).getByText("Zero")).toBeInTheDocument();
});

test("Localize shell navigation and shortcut help", async () => {
  const mediaQuery = mockDesktopLayout();
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Localized conversation"),
  ]);
  setMockWorkflowAutomations([
    createMockWorkflowAutomation({
      chatThreadId: EXISTING_THREAD_ID,
    }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${EXISTING_THREAD_ID}`,
    locale: "pt-BR",
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
  expect(within(rail).getByLabelText("Onde Zero trabalha")).toBeInTheDocument();

  act(() => {
    mediaQuery.setMatches(false);
  });

  expect(screen.getByLabelText("Abrir menu")).toBeInTheDocument();
  await expect(
    screen.findByLabelText("Abrir artefatos no celular"),
  ).resolves.toBeInTheDocument();
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

  click(within(dialog).getByLabelText("Fechar atalhos de teclado"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Atalhos de teclado" }),
    ).not.toBeInTheDocument();
  });
});

test("Locate the current chat in a long sidebar history", async () => {
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

  await setupSidebarPage({
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

test("Mark all current-agent chats read from the chat-list menu", async () => {
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
      changeChatThreadReadCursor();
      return respond(204);
    },
  );

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  await waitFor(() => {
    expect(within(list).getByText("Unread conversation")).toBeInTheDocument();
    expect(within(list).getAllByLabelText("Unread").length).toBeGreaterThan(0);
  });

  click(within(list).getByLabelText("Open chat list menu"));
  await waitFor(() => {
    expect(
      queryAllByRoleFast("menuitem").map((item) => {
        return item.textContent?.replace(/\s+/g, " ").trim();
      }),
    ).toStrictEqual(["Mark all read", "All chats", "Unread only"]);
  });
  const menuWithMarkAllRead =
    document.querySelector<HTMLElement>('[role="menu"]');
  if (!menuWithMarkAllRead) {
    throw new Error("Open chat list menu not found");
  }
  expect(
    menuWithMarkAllRead.querySelectorAll('[role="separator"]'),
  ).toHaveLength(1);
  click(menuItemByText("Mark all read"));

  await waitFor(() => {
    expect(markedAgentIds).toStrictEqual([AGENT_ID]);
    expect(within(list).queryByLabelText("Unread")).not.toBeInTheDocument();
  });

  click(within(list).getByLabelText("Open chat list menu"));
  await waitFor(() => {
    expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
    expect(
      queryAllByRoleFast("menuitem").map((item) => {
        return item.textContent?.replace(/\s+/g, " ").trim();
      }),
    ).toStrictEqual(["All chats", "Unread only"]);
    const menuWithoutMarkAllRead =
      document.querySelector<HTMLElement>('[role="menu"]');
    if (!menuWithoutMarkAllRead) {
      throw new Error("Open chat list menu not found");
    }
    expect(
      menuWithoutMarkAllRead.querySelectorAll('[role="separator"]'),
    ).toHaveLength(0);
  });
});

test("Mark all of an agent’s chats read", async () => {
  mockMobileLayout();
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
      changeChatThreadReadCursor();
      return respond(204);
    },
  );

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const nav = await waitFor(() => {
    const current = mobileSidebar();
    expect(within(current).getByText("Research Agent")).toBeInTheDocument();
    return current;
  });
  const researchSidebarRow = agentRowByName(nav, "Research Agent");
  const supportSidebarRow = agentRowByName(nav, "Support Agent");
  await waitFor(() => {
    expect(
      within(researchSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  click(within(researchSidebarRow).getByLabelText("Open agent menu"));
  click(menuItemByText("Mark all read"));

  await waitFor(() => {
    expect(markedAgentIds).toStrictEqual([RESEARCH_AGENT_ID]);
    expect(
      within(researchSidebarRow).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  click(within(researchSidebarRow).getByLabelText("Open agent menu"));
  expect(queryMenuItemByText("Mark all read")).not.toBeInTheDocument();
  expect(menuItemByText("Unpin")).toBeInTheDocument();
});

test("Mark conversations read and unread from the sidebar", async () => {
  prepareDefaultAgent();
  const unreadSnapshotRefreshed = context.mocks.deferred<void>();
  const markReadDeferred = context.mocks.deferred<void>();
  const markReadStarted = context.mocks.deferred<void>();
  const markReadCompleted = context.mocks.deferred<void>();
  const unreadThreadIds = new Set<string>();
  let unreadAt = "2026-03-10T00:05:00Z";
  let holdReleaseRead = false;
  const serverUnreads = () => {
    return [...unreadThreadIds].map((threadId) => {
      return { threadId, unreadAt };
    });
  };
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    const unreads = serverUnreads();
    if (
      unreadThreadIds.has(EXISTING_THREAD_ID) &&
      !unreadSnapshotRefreshed.settled()
    ) {
      unreadSnapshotRefreshed.resolve();
    }
    return respond(200, { unreads });
  });
  context.mocks.api(
    chatThreadMarkUnreadContract.markUnread,
    ({ params, respond }) => {
      unreadThreadIds.add(params.id);
      changeChatThreadReadCursor({
        threadId: params.id,
        agentId: AGENT_ID,
        lastReadAt: null,
      });
      return respond(200, {
        lastReadAt: null,
        unreads: serverUnreads(),
      });
    },
  );
  context.mocks.api(
    chatThreadMarkReadContract.markRead,
    async ({ params, respond }) => {
      unreadThreadIds.delete(params.id);
      if (params.id === EXISTING_THREAD_ID && holdReleaseRead) {
        markReadStarted.resolve();
        await markReadDeferred.promise;
        markReadCompleted.resolve();
      }
      return respond(200, {
        lastReadAt: "2026-03-10T00:05:00Z",
        unreads: serverUnreads(),
      });
    },
  );
  context.mocks.api(
    chatThreadEventsContract.rows,
    ({ params, query, respond }) => {
      return respond(
        200,
        chatEventRowsResponse(
          mockChatEventRows(
            params.threadId === EXISTING_THREAD_ID
              ? [
                  {
                    id: "release-message-1",
                    threadId: EXISTING_THREAD_ID,
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
          query,
        ),
      );
    },
  );
  context.mocks.api(browserContract.get, ({ respond }) => {
    return respond(404, {
      error: {
        code: "BROWSER_NOT_FOUND",
        message: "Managed browser not found",
      },
    });
  });

  await setupSidebarPage({ context, path: `/chats/${EXISTING_THREAD_ID}` });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Release plan")).toBeInTheDocument();
    expect(within(sidebar()).getByText("Incident notes")).toBeInTheDocument();
  });

  openThreadMenu("Release plan");
  click(menuItemByText("Mark unread"));
  await unreadSnapshotRefreshed.promise;
  expect(
    within(threadRowByTitle("Release plan")).queryByLabelText("Unread"),
  ).not.toBeInTheDocument();

  click(threadLinkByTitle("Incident notes"));

  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });

  holdReleaseRead = true;
  click(threadLinkByTitle("Release plan"));
  await markReadStarted.promise;
  click(threadLinkByTitle("Incident notes"));

  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
  });

  markReadDeferred.resolve();
  await markReadCompleted.promise;

  unreadAt = "2026-03-10T00:06:00Z";
  unreadThreadIds.add(EXISTING_THREAD_ID);
  context.mocks.ably.trigger("chatThreadReadCursorUpdated", {
    threadId: EXISTING_THREAD_ID,
    agentId: AGENT_ID,
    lastReadAt: null,
  });

  await waitFor(() => {
    expect(
      within(threadRowByTitle("Release plan")).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });
});

test("Move to the next relevant agent with a shortcut", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  mockSidebarThreadStory([
    createThread(INCIDENT_THREAD_ID, "Support escalation", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);
  mockUnreadAgents(() => {
    return [SUPPORT_AGENT_ID];
  });

  await setupSidebarPage({
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
    expect(
      within(sidebar()).getByText("Support escalation"),
    ).toBeInTheDocument();
  });
});

test("Navigate pinned agents from the mobile sidebar", async () => {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  const openedTargets = context.mocks.browser.open();

  await setupSidebarPage({
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

test("Open and use workspace search with the keyboard", async () => {
  prepareAgents();
  mockSidebarThreadStory([
    createThread(INCIDENT_THREAD_ID, "Support escalation", {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    }),
  ]);

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search chats, messages, workflows, and artifacts...",
  });
  const search = within(dialog).getByPlaceholderText(
    "Search chats, messages, workflows, and artifacts...",
  );

  await fill(search, "support");

  await waitFor(() => {
    expect(within(dialog).getByText("Support escalation")).toBeInTheDocument();
  });

  fireEvent.keyDown(search, { key: "ArrowDown" });
  fireEvent.keyDown(search, { key: "Enter" });

  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", {
        name: "Search chats, messages, workflows, and artifacts...",
      }),
    ).not.toBeInTheDocument();
    expect(document.title).toBe("Support escalation | VM0");
  });
});

test("Show current shortcuts without stacking help over workspace search", async () => {
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    featureSwitches: {
      [FeatureSwitchKey.ComposerVoiceInputShortcut]: true,
    },
  });

  await waitFor(() => {
    expect(sidebar()).toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

  const shortcutDialog = await screen.findByRole("dialog", {
    name: "Keyboard Shortcuts",
  });
  expect(
    within(shortcutDialog).getByText("Show shortcuts"),
  ).toBeInTheDocument();
  expect(within(shortcutDialog).getByText("Search workspace")).toBeVisible();
  expect(within(shortcutDialog).getByText("Voice input")).toBeVisible();
  click(within(shortcutDialog).getByLabelText("Close keyboard shortcuts"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Keyboard Shortcuts" }),
    ).not.toBeInTheDocument();
  });

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search chats, messages, workflows, and artifacts...",
  });

  fireEvent.keyDown(document.body, { key: "?", shiftKey: true });

  expect(
    screen.queryByRole("dialog", { name: "Keyboard Shortcuts" }),
  ).not.toBeInTheDocument();
  expect(screen.getAllByRole("dialog")).toStrictEqual([dialog]);
});

test("Open workspace search once from a focused composer shortcut", async () => {
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await screen.findByPlaceholderText(PLACEHOLDER);
  const composer = mountedComposer();
  composer.focus();
  const repeatedEvent = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
    repeat: true,
    bubbles: true,
    cancelable: true,
  });
  composer.dispatchEvent(repeatedEvent);

  expect(repeatedEvent.defaultPrevented).toBeFalsy();
  expect(
    screen.queryByRole("dialog", {
      name: "Search chats, messages, workflows, and artifacts...",
    }),
  ).not.toBeInTheDocument();

  const event = new KeyboardEvent("keydown", {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
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

test("Open workspace search from a mobile viewport", async () => {
  mockMobileLayout();
  prepareAgents();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  await waitFor(() => {
    expect(mobileSidebar()).toBeInTheDocument();
  });
  expect(screen.queryByTestId("chat-list-column")).not.toBeInTheDocument();

  fireEvent.keyDown(document.body, {
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
  });

  const dialog = await screen.findByRole("dialog", {
    name: "Search chats, messages, workflows, and artifacts...",
  });
  expect(dialog).toBeInTheDocument();
});

test("Pin and unpin agents without closing the pin manager", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds: [RESEARCH_AGENT_ID] });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(within(grid).getAllByTestId("pinned-agent-card")).toHaveLength(2);
  });

  click(screen.getByLabelText("Pin an agent"));

  const dialogList = await screen.findByTestId("pin-agent-dialog-list");
  const supportRow = commandItemByText(dialogList, "Support Agent");
  click(buttonByText("Pin", supportRow));

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
  await expect(
    screen.findByText("Support Agent pinned"),
  ).resolves.toBeInTheDocument();

  click(buttonByText("Unpin", commandItemByText(dialogList, "Support Agent")));

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

test("Show pinned agents before unread indicators finish loading", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  const indicatorRequestStarted = context.mocks.deferred<void>();
  const releaseIndicators = context.mocks.deferred<void>();
  context.mocks.api(chatThreadsContract.indicators, async ({ respond }) => {
    if (!indicatorRequestStarted.settled()) {
      indicatorRequestStarted.resolve(undefined);
    }
    await releaseIndicators.promise;
    return respond(200, {
      agents: { [SUPPORT_AGENT_ID]: "unread" },
      threads: {},
    });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });
  await indicatorRequestStarted.promise;

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual(["Zero", "Research Agent"]);
  });

  releaseIndicators.resolve(undefined);
  await waitFor(() => {
    expect(pinnedAgentNames(grid)).toStrictEqual([
      "Zero",
      "Research Agent",
      "Support Agent",
    ]);
  });
});

test("Preserve the user’s pinned-agent order", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [SUPPORT_AGENT_ID, RESEARCH_AGENT_ID],
  });

  await setupSidebarPage({
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

test("Highlight the current thread’s agent in the pinned grid", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Research kickoff", {
      agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
    }),
  ]);

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  const grid = await screen.findByTestId("pinned-agents-grid");
  await waitFor(() => {
    expect(pinnedAgentLink(grid, "Research Agent")).toHaveAttribute(
      "aria-current",
      "page",
    );
  });
  expect(pinnedAgentLink(grid, "Zero")).not.toHaveAttribute("aria-current");
});

test("Recognize and pin sidebar conversation states", async () => {
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

  await setupSidebarPage({
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

test("Refresh agent and thread unread indicators", async () => {
  mockMobileLayout();
  prepareAgents();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Remote unread conversation"),
  ]);
  let hasUnread = false;
  context.mocks.api(chatThreadsContract.indicators, ({ respond }) => {
    return respond(200, {
      agents: hasUnread ? { [AGENT_ID]: "unread" } : {},
      threads: hasUnread ? { [EXISTING_THREAD_ID]: "unread" } : {},
    });
  });
  context.mocks.api(chatThreadsContract.unreads, ({ respond }) => {
    return respond(200, {
      unreads: hasUnread
        ? [
            {
              threadId: EXISTING_THREAD_ID,
              unreadAt: "2026-03-10T00:05:00Z",
            },
          ]
        : [],
    });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    sharedWorkerTestTransport: "message-port",
  });

  const nav = await waitFor(() => {
    const current = mobileSidebar();
    expect(within(current).getByText("Zero")).toBeInTheDocument();
    return current;
  });
  const agentRow = agentRowByName(nav, "Zero");
  const threadRow = await waitFor(() => {
    return threadRowByTitle("Remote unread conversation", nav);
  });
  await waitFor(() => {
    expect(within(agentRow).queryByLabelText("Unread")).toBeNull();
    expect(within(threadRow).queryByLabelText("Unread")).toBeNull();
  });

  hasUnread = true;
  changeChatThreadList();

  await waitFor(() => {
    expect(within(agentRow).getByLabelText("Unread")).toBeInTheDocument();
    expect(within(threadRow).getByLabelText("Unread")).toBeInTheDocument();
  });
});

test("Rename a conversation from the sidebar", async () => {
  prepareDefaultAgent();
  mockSidebarThreadStory([
    createThread(EXISTING_THREAD_ID, "Release plan"),
    createThread(INCIDENT_THREAD_ID, "Incident notes"),
  ]);

  await setupSidebarPage({
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

  openThreadMenu("Incident notes");
  click(menuItemByText("Rename chat"));

  const draftDialog = await screen.findByRole("dialog", {
    name: "Rename chat",
  });
  const draftInput = within(draftDialog).getByPlaceholderText("Chat title");
  expect(draftInput).toHaveValue("Incident notes");
  await fill(draftInput, "Unsaved title");
  const finishCloseAnimation = holdElementAnimations(draftDialog);
  click(buttonByText("Cancel", draftDialog));

  expect(draftInput).toBeInTheDocument();
  expect(draftInput).toBeVisible();
  expect(draftInput).toHaveValue("Unsaved title");

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
  expect(within(reopenedDialog).getByPlaceholderText("Chat title")).toHaveValue(
    "Incident notes",
  );
});

test("Reorder pinned agents while keeping Zero first", async () => {
  const pinnedAgentIds = prepareOverflowingPinnedAgents();
  context.mocks.data.userPreferences({ pinnedAgentIds });

  await setupSidebarPage({
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
  await waitFor(() => {
    expect(
      within(target).getByTestId("pinned-agent-drop-caret"),
    ).toBeInTheDocument();
  });
  expect(
    within(target).getByTestId("pinned-agent-drop-caret").className,
  ).toContain("-right-");
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

  const orderAfterReorder = pinnedAgentNames(grid);
  const lead = pinnedAgentLink(grid, "Zero");
  const leadDropTransfer = createDataTransferStub();
  fireEvent.dragStart(pinnedAgentLink(grid, "Research Agent"), {
    dataTransfer: leadDropTransfer,
  });
  expect(
    fireEvent.dragOver(lead, { dataTransfer: leadDropTransfer }),
  ).toBeFalsy();
  expect(fireEvent.drop(lead, { dataTransfer: leadDropTransfer })).toBeFalsy();
  fireEvent.dragEnd(pinnedAgentLink(grid, "Research Agent"), {
    dataTransfer: leadDropTransfer,
  });
  expect(pinnedAgentNames(grid)).toStrictEqual(orderAfterReorder);
  expect(pinnedAgentLink(grid, "Zero")).toBeInTheDocument();
});

test("Search and open workflows and artifacts from the shell", async () => {
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
    official: null,
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

  await setupSidebarPage({
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
  expect(within(dialog).queryByText("launch-demo.mp4")).not.toBeInTheDocument();

  click(buttonByText("Artifacts", dialog));
  expect(within(dialog).getByText("launch-demo.mp4")).toBeInTheDocument();
  expect(within(dialog).queryByText("Launch workflow")).not.toBeInTheDocument();
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
    key: "f",
    code: "KeyF",
    ctrlKey: true,
    shiftKey: true,
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

test("Search, pin, and open an agent from the pin manager", async () => {
  prepareAgents();
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });

  mockChatThreadSnapshot(() => {
    return [researchThread];
  });

  await setupSidebarPage({ context, path: `/agents/${AGENT_ID}/chat` });

  const grid = await screen.findByTestId("pinned-agents-grid");
  click(screen.getByLabelText("Pin an agent"));

  const dialog = await screen.findByRole("dialog", { name: "Pin an agent" });
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
    expect(within(dialog).getByText("No results found")).toBeInTheDocument();
    expect(within(dialog).queryByText("Support Agent")).not.toBeInTheDocument();
  });

  click(within(dialog).getByLabelText("Clear search"));

  await waitFor(() => {
    expect(within(dialog).getByText("Research Agent")).toBeInTheDocument();
  });

  const researchRow = commandItemByText(dialog, "Research Agent");
  click(buttonByText("Pin", researchRow));

  await waitFor(() => {
    expect(
      buttonByText("Unpin", commandItemByText(dialog, "Research Agent")),
    ).toBeInTheDocument();
    expect(pinnedAgentNames(grid)).toContain("Research Agent");
  });

  click(within(dialog).getByLabelText("Close"));
  await waitFor(() => {
    expect(
      screen.queryByRole("dialog", { name: "Pin an agent" }),
    ).not.toBeInTheDocument();
  });
  click(pinnedAgentLink(grid, "Research Agent"));

  await waitFor(() => {
    expect(
      within(sidebar()).getByText("Chats with Research Agent"),
    ).toBeInTheDocument();
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
});

test("Search workspace chats and messages", async () => {
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
              },
            ]
          : [],
      hasMore: false,
    });
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  click(within(list).getByLabelText("Search workspace"));

  const dialog = await screen.findByRole("dialog", {
    name: "Search chats, messages, workflows, and artifacts...",
  });
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

test("Show unread agents and contextual actions in the pinned section", async () => {
  mockMobileLayout();
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID],
  });

  let unreadAgentIds = [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID];
  mockUnreadAgents(() => {
    return unreadAgentIds;
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
    sharedWorkerTestTransport: "message-port",
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

  unreadAgentIds = [SUPPORT_AGENT_ID];
  changeChatThreadReadCursor({
    agentId: RESEARCH_AGENT_ID,
  });

  await waitFor(() => {
    expect(
      within(researchSidebarRow).queryByLabelText("Unread"),
    ).not.toBeInTheDocument();
    expect(
      within(supportSidebarRow).getByLabelText("Unread"),
    ).toBeInTheDocument();
  });
});

test("Show useful search-result ages and an illustrated empty state", async () => {
  const now = Date.parse("2026-03-10T12:00:00.000Z");
  mockNow(now, context.signal);
  prepareAgents();
  mockSidebarThreadStory([
    createThread(RESEARCH_THREAD_ID, "Minutes old", {
      sortAt: new Date(now - 5 * 60 * 1000).toISOString(),
    }),
    createThread(INCIDENT_THREAD_ID, "Hours old", {
      sortAt: new Date(now - 3 * 60 * 60 * 1000).toISOString(),
    }),
    createThread(AUTOMATION_THREAD_ID, "Days old", {
      sortAt: new Date(now - 2 * 24 * 60 * 60 * 1000).toISOString(),
    }),
    createThread(ARCHIVED_THREAD_ID, "Older than a month", {
      sortAt: new Date(now - 60 * 24 * 60 * 60 * 1000).toISOString(),
    }),
  ]);
  context.mocks.api(chatSearchContract.search, ({ respond }) => {
    return respond(200, { results: [], hasMore: false });
  });
  context.mocks.api(artifactCatalogContract.list, ({ respond }) => {
    return respond(200, { artifacts: [], nextCursor: null });
  });

  await setupSidebarPage({
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

test("Update the existing chat list when switching agents", async () => {
  prepareAgents();
  const supportUnreadGate = context.mocks.deferred<void>();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
  });
  const researchThread = createThread(RESEARCH_THREAD_ID, "Research kickoff", {
    agent: { id: RESEARCH_AGENT_ID, avatarUrl: null },
  });
  const supportThread = createThread(INCIDENT_THREAD_ID, "Support escalation", {
    agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
  });
  const olderSupportThread = createThread(
    AUTOMATION_THREAD_ID,
    "Support archive",
    {
      agent: { id: SUPPORT_AGENT_ID, avatarUrl: null },
    },
  );
  mockSidebarThreadStory([researchThread, supportThread, olderSupportThread]);
  context.mocks.api(chatThreadsContract.unreads, async ({ query, respond }) => {
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
  });

  await setupSidebarPage({
    context,
    path: `/chats/${RESEARCH_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
  openChatListMenu();
  click(menuItemByText("Unread only"));
  await waitFor(() => {
    expect(within(sidebar()).getByText("Research kickoff")).toBeInTheDocument();
  });
  const chatList = within(sidebar()).getByLabelText("Chat threads");

  fireEvent.keyDown(document.body, {
    key: "}",
    ctrlKey: true,
    shiftKey: true,
  });

  await waitFor(() => {
    expect(pathname()).toBe(`/agents/${SUPPORT_AGENT_ID}/chat`);
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

test("Use context actions on pinned agents", async () => {
  prepareAgents();
  context.mocks.data.userPreferences({
    pinnedAgentIds: [RESEARCH_AGENT_ID, SUPPORT_AGENT_ID],
  });

  await setupSidebarPage({
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

test("Collapse the chat-list upgrade slot when no upgrade card exists", async () => {
  prepareDefaultAgent();
  mockChatThreadSnapshot(() => {
    return [];
  });
  context.mocks.api(billingStatusContract.get, ({ respond }) => {
    return respond(200, topTierBillingStatus());
  });

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const list = await screen.findByTestId("chat-list-column");
  await expect(
    within(list).findByTestId("pinned-agents-horizontal"),
  ).resolves.toBeVisible();
  const upgradeSlot = list.lastElementChild;
  expect(upgradeSlot).toBeEmptyDOMElement();
  expect(upgradeSlot).toHaveClass("empty:hidden");
});

test("Show the three-column chat navigation and actions", async () => {
  prepareDefaultAgent();

  await setupSidebarPage({
    context,
    path: `/agents/${AGENT_ID}/chat`,
  });

  const rail = await waitFor(() => {
    return screen.getByTestId("labeled-nav-rail");
  });

  const chatLink = within(rail).getByLabelText("Chat");
  expect(within(rail).getByText("Chat")).toBeInTheDocument();
  expect(chatLink.querySelector(".lucide-message-circle")).toBeInTheDocument();
  expect(within(rail).getByText("Agents")).toBeInTheDocument();
  expect(within(rail).getByText("Connectors")).toBeInTheDocument();

  const list = screen.getByTestId("chat-list-column");
  expect(within(list).getByText("Chat")).toBeInTheDocument();
  const searchButton = within(list).getByLabelText("Search workspace");
  const chatThreadsTitle = within(list).getByText("Chats with Zero");
  if (!searchButton.parentElement || !chatThreadsTitle.parentElement) {
    throw new Error("Chat action headers not found");
  }
  const headerNewChat = within(searchButton.parentElement).getByLabelText(
    "New chat",
  );
  const threadNewChat = within(chatThreadsTitle.parentElement).getByLabelText(
    "New chat",
  );
  expect(searchButton).toHaveAttribute(
    "aria-keyshortcuts",
    "Meta+Shift+F Control+Shift+F",
  );
  expect(headerNewChat.querySelector(".lucide-square-pen")).toBeInTheDocument();
  expect(threadNewChat.querySelector(".lucide-plus")).toBeInTheDocument();
  expect(
    within(list).getByTestId("pinned-agents-horizontal"),
  ).toBeInTheDocument();
});
