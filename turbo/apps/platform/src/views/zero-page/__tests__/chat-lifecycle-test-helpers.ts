import { screen, waitFor, within } from "@testing-library/react";
import { expect, vi } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadMarkReadContract,
  chatThreadEventsContract,
  chatThreadRenameContract,
  chatThreadsContract,
  type ChatEvent,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowAutomationsContract,
  type ZeroWorkflowAutomationUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  createMockWorkflowAutomation,
  setMockWorkflowAutomations,
} from "../../../mocks/handlers/workflow-automations-store.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage as baseDetachedSetupPage,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import { mockChatLifecycle, threadListSnapshot } from "./chat-test-helpers.ts";
import {
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";
export const context = testContext();

export function detachedSetupPage(
  options: Parameters<typeof baseDetachedSetupPage>[0],
): void {
  baseDetachedSetupPage(options);
}

export const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
export const AUTOMATION_THREAD_ID = "b0000000-0000-4000-a000-000000000701";
export const FOLLOWUP_THREAD_ID = "b0000000-0000-4000-a000-000000000704";
export const HISTORY_THREAD_ID = "b0000000-0000-4000-a000-000000000705";
export const EVENT_SOURCED_RENAME_THREAD_ID =
  "b0000000-0000-4000-a000-000000000706";
export const KEYBOARD_PREV_THREAD_ID = "b0000000-0000-4000-a000-000000000707";
export const KEYBOARD_CURRENT_THREAD_ID =
  "b0000000-0000-4000-a000-000000000708";
export const KEYBOARD_NEXT_THREAD_ID = "b0000000-0000-4000-a000-000000000709";
export const SERVER_QUEUED_VISIBLE_THREAD_ID =
  "b0000000-0000-4000-a000-000000000710";
export const SERVER_QUEUED_RESOLVED_THREAD_ID =
  "b0000000-0000-4000-a000-000000000711";
export const SERVER_QUEUED_RUN_THREAD_ID =
  "b0000000-0000-4000-a000-000000000712";
export const RUNNING_THREAD_ID = "b0000000-0000-4000-a000-000000000713";
export const COMPLETED_THREAD_ID = "b0000000-0000-4000-a000-000000000714";
export const COMPLETED_MARKER_ONLY_THREAD_ID =
  "b0000000-0000-4000-a000-000000000715";
export const COMPUTER_USE_SELECTION_THREAD_ID =
  "b0000000-0000-4000-a000-000000000716";
export const COMPUTER_USE_SEND_THREAD_ID =
  "b0000000-0000-4000-a000-000000000717";
export const COMPUTER_USE_SAVED_SELECTION_THREAD_ID =
  "b0000000-0000-4000-a000-000000000718";
export const AGENT_CHAT_PATH = `/agents/${AGENT_ID}/chat`;

type ChatMessageSeed = Omit<
  Extract<ChatEvent, { eventType: "input.prompt" }>,
  "seqId"
>;

export function replaceNavigatorProperty(
  property: string,
  value: unknown,
): void {
  const descriptor = Object.getOwnPropertyDescriptor(navigator, property);
  Object.defineProperty(navigator, property, {
    configurable: true,
    value,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(navigator, property, descriptor);
        return;
      }
      Reflect.deleteProperty(navigator, property);
    },
    { once: true },
  );
}

export function mockMacUserAgentData(architecture: string): void {
  replaceNavigatorProperty("userAgentData", {
    platform: "macOS",
    getHighEntropyValues: () => {
      return Promise.resolve({ architecture, platform: "macOS" });
    },
  });
}

export function computerUsePermissions() {
  return {
    accessibility: true,
    screenRecording: true,
    automation: {
      chrome: { status: "unknown" as const, updatedAt: null, reason: null },
      safari: { status: "unknown" as const, updatedAt: null, reason: null },
    },
  };
}

export interface PushBrowserMock {
  readonly register: ReturnType<typeof vi.fn>;
}

export type TestPushManager = Pick<
  PushManager,
  "getSubscription" | "subscribe"
>;

export interface TestServiceWorkerRegistration {
  readonly pushManager: TestPushManager;
}

export interface TestServiceWorkerContainer {
  readonly register: () => Promise<TestServiceWorkerRegistration>;
}

export async function readSingleRichClipboardWrite(clipboard: {
  readonly writes: ClipboardItem[][];
}): Promise<ClipboardItem> {
  await waitFor(() => {
    expect(clipboard.writes).toHaveLength(1);
    expect(clipboard.writes[0]).toHaveLength(1);
  });
  const item = clipboard.writes[0]?.[0];
  if (!item) {
    throw new Error("clipboard item not found");
  }
  return item;
}

export async function readClipboardItemText(
  item: ClipboardItem,
  type: string,
): Promise<string> {
  const blob = await item.getType(type);
  return await blob.text();
}

export function parseChatClipboardPayload(html: string): {
  text: string;
  attachments: {
    id: string | null;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }[];
  structuredPrompt?: UserMessageDocument;
} {
  const doc = new DOMParser().parseFromString(html, "text/html");
  const encoded = doc.querySelector<HTMLElement>("[data-vm0-chat-message]")
    ?.dataset.vm0ChatMessage;
  if (!encoded) {
    throw new Error("chat clipboard payload not found");
  }
  return JSON.parse(decodeURIComponent(encoded)) as {
    text: string;
    attachments: {
      id: string | null;
      url: string;
      filename: string;
      contentType: string;
      size: number;
    }[];
    structuredPrompt?: UserMessageDocument;
  };
}

export function mockPushBrowserSupport(): PushBrowserMock {
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY_PREVIEW", "AQIDBA");
  vi.stubGlobal("PushManager", class TestPushManager {});
  let notificationPermission: NotificationPermission = "default";
  vi.stubGlobal("Notification", {
    get permission() {
      return notificationPermission;
    },
    requestPermission: vi.fn(() => {
      notificationPermission = "granted";
      return Promise.resolve(notificationPermission);
    }),
  });

  const subscriptionKeys: Record<PushEncryptionKeyName, ArrayBuffer> = {
    p256dh: new Uint8Array([1, 2, 3]).buffer,
    auth: new Uint8Array([4, 5, 6]).buffer,
  };
  const subscription = {
    endpoint: "https://push.example.test/subscriptions/chat-send",
    getKey: (name: PushEncryptionKeyName) => {
      return subscriptionKeys[name] ?? null;
    },
  } satisfies Pick<PushSubscription, "endpoint" | "getKey">;
  const pushManager: TestPushManager = {
    getSubscription: vi.fn(() => {
      return Promise.resolve(null);
    }),
    subscribe: vi.fn(() => {
      return Promise.resolve(subscription as PushSubscription);
    }),
  };
  const registration = {
    pushManager,
  } satisfies TestServiceWorkerRegistration;
  const register = vi.fn(() => {
    return Promise.resolve(registration);
  });
  const descriptor = Object.getOwnPropertyDescriptor(
    navigator,
    "serviceWorker",
  );
  Object.defineProperty(navigator, "serviceWorker", {
    configurable: true,
    value: {
      register,
    } satisfies TestServiceWorkerContainer,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (descriptor) {
        Object.defineProperty(navigator, "serviceWorker", descriptor);
        return;
      }
      Reflect.deleteProperty(navigator, "serviceWorker");
    },
    { once: true },
  );

  return { register };
}

export function makeRunGroupMessages(params: {
  readonly label: string;
  readonly count: number;
  readonly runGroupId: string;
  readonly startMinute: number;
}): MockChatEventInput[] {
  return Array.from({ length: params.count }, (_, index) => {
    const itemNumber = index + 1;
    const runId = `${params.runGroupId}-run-${itemNumber}`;
    const createdAt = new Date(
      Date.UTC(2026, 5, 9, 10, params.startMinute + index, 0),
    ).toISOString();
    const assistantCreatedAt = new Date(
      Date.UTC(2026, 5, 9, 10, params.startMinute + index, 30),
    ).toISOString();
    return [
      {
        id: `msg-${params.label.toLowerCase()}-${itemNumber}-user`,
        role: "user" as const,
        content: params.label,
        runId,
        runGroupId: params.runGroupId,
        createdAt,
      },
      {
        id: `msg-${params.label.toLowerCase()}-${itemNumber}-assistant`,
        role: "assistant" as const,
        content: `${params.label} reply ${itemNumber}`,
        runId,
        runGroupId: params.runGroupId,
        createdAt: assistantCreatedAt,
      },
    ];
  }).flat();
}

export function expectTextBefore(
  container: HTMLElement,
  beforeText: string,
  afterText: string,
): void {
  const before = within(container).getByText(beforeText);
  const after = within(container).getByText(afterText);
  expect(
    before.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING,
  ).toBeTruthy();
}

export function makeMessage(
  id: string,
  text: string,
  threadId = "00000000-0000-4000-8000-000000000001",
): ChatMessageSeed {
  return {
    id,
    threadId,
    eventType: "input.prompt",
    content: text,
    createdAt: "2026-05-01T00:00:00Z",
  };
}

export function mockKeyboardNavigationThreads({
  leadingThreadCount = 0,
  currentTitle = "Current keyboard thread",
  currentDetailTitle = currentTitle,
}: {
  leadingThreadCount?: number;
  currentTitle?: string;
  currentDetailTitle?: string | null;
} = {}): void {
  const leadingFixtures = Array.from(
    { length: leadingThreadCount },
    (_, index) => {
      const itemNumber = index + 1;
      return {
        id: `b0000000-0000-4000-a000-${String(720 + index).padStart(12, "0")}`,
        title: `Leading keyboard thread ${itemNumber}`,
        detailTitle: `Leading keyboard thread ${itemNumber}`,
        message: `Leading thread launch note ${itemNumber}`,
      };
    },
  );
  const threadFixtures = [
    ...leadingFixtures,
    {
      id: KEYBOARD_PREV_THREAD_ID,
      title: "Previous keyboard thread",
      detailTitle: "Previous keyboard thread",
      message: "Previous thread launch note",
    },
    {
      id: KEYBOARD_CURRENT_THREAD_ID,
      title: currentTitle,
      detailTitle: currentDetailTitle,
      message: "Current thread launch note",
    },
    {
      id: KEYBOARD_NEXT_THREAD_ID,
      title: "Next keyboard thread",
      detailTitle: "Next keyboard thread",
      message: "Next thread launch note",
    },
  ];
  const byId = new Map(
    threadFixtures.map((thread) => {
      return [thread.id, thread];
    }),
  );
  const threadList = threadFixtures.map((thread, index) => {
    const sortMinute = threadFixtures.length - index - 1;
    return {
      id: thread.id,
      title: thread.title,
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: `2026-06-01T00:0${sortMinute}:00Z`,
      pinnedAt: null,
    };
  });
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threadListSnapshot(threadList),
      latestEventId: null,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
    return respond(200, { threadIds: [] });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    const thread = byId.get(params.id);
    if (!thread) {
      return respond(404, {
        error: { message: "Thread not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      lastReadAt: null,
      computerUseHostId: null,
      codexServiceTier: null,
    });
  });
  context.mocks.api(
    chatThreadEventsContract.list,
    ({ params, query, respond }) => {
      if (query.sinceSeqId || query.sinceId) {
        return respond(200, { events: [] });
      }
      const thread = byId.get(params.threadId);
      return respond(200, {
        events: normalizeMockChatEvents(
          thread
            ? [
                {
                  id: `${thread.id}-message`,
                  role: "user",
                  content: thread.message,
                  createdAt: "2026-06-01T00:00:00Z",
                },
              ]
            : [],
        ),
        hasHistoryBefore: false,
      });
    },
  );
  context.mocks.api(chatThreadRenameContract.rename, ({ respond }) => {
    return respond(204);
  });
}

export function mockAutomationThread(): void {
  mockChatLifecycle(context, {
    threadId: AUTOMATION_THREAD_ID,
    threadTitle: "Scheduled launch review",
    historyMessages: [
      {
        role: "user",
        content: "Review launch risks",
        createdAt: "2026-06-09T10:00:00Z",
      },
      {
        role: "assistant",
        content: "I'll review this on the schedule.",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
  });
}

export function mockWorkflowAutomationUpdate(
  onUpdate: (
    automationId: string,
    body: ZeroWorkflowAutomationUpdateRequest,
  ) => void,
): void {
  context.mocks.api(
    zeroWorkflowAutomationsContract.update,
    ({ body, params, respond }) => {
      onUpdate(params.id, body);
      if ("schedule" in body) {
        return respond(
          200,
          createMockWorkflowAutomation({
            id: params.id,
            chatThreadId: AUTOMATION_THREAD_ID,
            kind: "schedule",
            schedule: body.schedule,
          }),
        );
      }
      return respond(
        200,
        createMockWorkflowAutomation({
          id: params.id,
          chatThreadId: AUTOMATION_THREAD_ID,
          kind: "event",
          eventType:
            body.eventConfig.event === "label_applied"
              ? "gmail-label-applied"
              : "gmail-new-message",
          eventConfig: body.eventConfig,
        }),
      );
    },
  );
}

export function mockServerQueuedThreadStories(): void {
  const threads = [
    {
      id: SERVER_QUEUED_VISIBLE_THREAD_ID,
      title: "Server queued run",
      messages: [
        {
          id: "msg-server-queued-visible-user",
          role: "user" as const,
          content: "Start queued deployment",
          runId: "run-server-queued-visible",
          seqId: 1,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-server-queued-visible-marker",
          role: "assistant" as const,
          content: null,
          runId: "run-server-queued-visible",
          runEventId: "queue:queued",
          seqId: 2,
          createdAt: "2026-06-09T10:00:01Z",
        },
      ] satisfies MockChatEventInput[],
      activeRunIds: ["run-server-queued-visible"],
    },
    {
      id: SERVER_QUEUED_RESOLVED_THREAD_ID,
      title: "Resolved server queue",
      messages: [
        {
          id: "msg-server-queued-resolved-user",
          role: "user" as const,
          content: "Watch queued deployment resolve",
          runId: "run-server-queued-resolved",
          seqId: 1,
          createdAt: "2026-06-09T10:05:00Z",
        },
        {
          id: "msg-server-queued-resolved-marker",
          role: "assistant" as const,
          content: null,
          runId: "run-server-queued-resolved",
          runEventId: "queue:queued",
          seqId: 2,
          createdAt: "2026-06-09T10:05:01Z",
        },
        {
          id: "msg-server-queued-resolved-assistant",
          role: "assistant" as const,
          content: "Queued deployment is running now.",
          runId: "run-server-queued-resolved",
          seqId: 3,
          createdAt: "2026-06-09T10:05:02Z",
        },
        {
          id: "msg-server-queued-resolved-completed",
          role: "assistant" as const,
          content: null,
          runId: "run-server-queued-resolved",
          runLifecycleEvent: "completed" as const,
          seqId: 4,
          createdAt: "2026-06-09T10:05:03Z",
        },
      ] satisfies MockChatEventInput[],
      activeRunIds: [],
    },
  ];
  const byId = new Map(
    threads.map((thread) => {
      return [thread.id, thread];
    }),
  );
  const threadList = threads.map((thread, index) => {
    return {
      id: thread.id,
      title: thread.title,
      agent: { id: AGENT_ID, avatarUrl: null },
      createdAt: "2026-06-09T10:00:00Z",
      updatedAt: `2026-06-09T10:0${index}:00Z`,
      pinnedAt: null,
    };
  });

  context.mocks.data.team([
    {
      id: AGENT_ID,
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threadListSnapshot(threadList),
      latestEventId: null,
    });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    const thread = byId.get(params.id);
    if (!thread) {
      return respond(404, {
        error: { message: "Thread not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      lastReadAt: "2026-06-09T10:00:00Z",
      computerUseHostId: null,
      codexServiceTier: null,
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
        events: normalizeMockChatEvents(
          byId.get(params.threadId)?.messages ?? [],
        ),
        hasHistoryBefore: false,
      });
    },
  );
  context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
    return respond(200, { lastReadAt: null, unreads: [] });
  });
}
export function buttonByText(
  text: string,
  container?: ParentNode,
): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

export async function findWorkflowComposerEditor(): Promise<HTMLElement> {
  return await waitFor(() => {
    const editor = document.querySelector(
      '.zero-composer [contenteditable="true"]',
    );
    if (!(editor instanceof HTMLElement)) {
      throw new Error("Composer editor not found");
    }
    return editor;
  });
}

export function mockWorkflowComposerWorkflows(): void {
  context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
    return respond(200, []);
  });
}

export function selectOptionByLabel(
  label: string,
  option: string | RegExp,
  container: HTMLElement,
): void {
  const control =
    within(container)
      .getAllByLabelText(label)
      .find((element) => {
        return element.getAttribute("role") === "combobox";
      }) ?? within(container).getByLabelText(label);
  click(control);
  click(screen.getByRole("option", { name: option }));
}

export async function openAutomationSidebarWithWorkflowAutomation(
  automation: ReturnType<typeof createMockWorkflowAutomation>,
): Promise<HTMLElement> {
  mockAutomationThread();
  setMockWorkflowAutomations([automation]);
  context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
    return respond(200, { runs: [] });
  });

  detachedSetupPage({
    context,
    path: `/chats/${AUTOMATION_THREAD_ID}`,
  });

  await waitFor(() => {
    expect(buttonByLabel("Automations")).toBeInTheDocument();
  });

  click(buttonByLabel("Automations"));

  await waitFor(() => {
    expect(screen.getByTestId("automation-sidebar")).toBeInTheDocument();
  });

  return screen.getByTestId("automation-sidebar");
}

export function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

export function linkByText(text: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!link) {
    throw new Error(`${text} link not found`);
  }
  return link;
}

export function linkByLabel(label: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!link) {
    throw new Error(`${label} link not found`);
  }
  return link;
}

export function queryLinkByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("link").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

export function queryButtonByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

export function chatScrollContainer(): HTMLElement {
  const element = document.querySelector("[data-scroll-container]");
  if (!(element instanceof HTMLElement)) {
    throw new Error("Chat scroll container not found");
  }
  return element;
}

export function chatComposerTextarea(): HTMLElement {
  const element = document.querySelector(
    '[data-chat-composer] [contenteditable="true"]',
  );
  if (!(element instanceof HTMLElement)) {
    throw new Error("Chat composer input not found");
  }
  return element;
}

export function activeElementIsInside(element: HTMLElement): boolean {
  return (
    document.activeElement === element ||
    (document.activeElement instanceof Node &&
      element.contains(document.activeElement))
  );
}

export function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
  });
}

export function mockThinkingTypewriterLayout({
  text,
  labelWidth,
  parentWidth,
  graphemeWidth,
  measureTextWidth = (value) => {
    return Array.from(value).length * graphemeWidth;
  },
}: {
  readonly text: string;
  readonly labelWidth: number;
  readonly parentWidth: number;
  readonly graphemeWidth: number;
  readonly measureTextWidth?: (value: string) => number;
}): void {
  const getContextDescriptor = Object.getOwnPropertyDescriptor(
    HTMLCanvasElement.prototype,
    "getContext",
  );
  const getBoundingClientRectDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "getBoundingClientRect",
  );
  const clientWidthDescriptor = Object.getOwnPropertyDescriptor(
    HTMLElement.prototype,
    "clientWidth",
  );

  const rectForWidth = (width: number): DOMRect => {
    return {
      bottom: 20,
      height: 20,
      left: 0,
      right: width,
      toJSON: () => {
        return {};
      },
      top: 0,
      width,
      x: 0,
      y: 0,
    } as DOMRect;
  };
  const elementWidth = (el: HTMLElement): number => {
    if (el.getAttribute("aria-label") === text) {
      return labelWidth;
    }
    if (
      Array.from(el.children).some((child) => {
        return child.getAttribute("aria-label") === text;
      })
    ) {
      return parentWidth;
    }
    return 0;
  };

  Object.defineProperty(HTMLCanvasElement.prototype, "getContext", {
    configurable: true,
    value: (contextId: string) => {
      if (contextId !== "2d") {
        return null;
      }
      return {
        measureText: (value: string) => {
          return {
            width: measureTextWidth(value),
          } as TextMetrics;
        },
      } as CanvasRenderingContext2D;
    },
  });
  Object.defineProperty(HTMLElement.prototype, "getBoundingClientRect", {
    configurable: true,
    value(this: HTMLElement) {
      return rectForWidth(elementWidth(this));
    },
  });
  Object.defineProperty(HTMLElement.prototype, "clientWidth", {
    configurable: true,
    get(this: HTMLElement) {
      return elementWidth(this);
    },
  });

  context.signal.addEventListener(
    "abort",
    () => {
      if (getContextDescriptor) {
        Object.defineProperty(
          HTMLCanvasElement.prototype,
          "getContext",
          getContextDescriptor,
        );
      }
      if (!getContextDescriptor) {
        Reflect.deleteProperty(HTMLCanvasElement.prototype, "getContext");
      }
      if (getBoundingClientRectDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "getBoundingClientRect",
          getBoundingClientRectDescriptor,
        );
      }
      if (!getBoundingClientRectDescriptor) {
        Reflect.deleteProperty(HTMLElement.prototype, "getBoundingClientRect");
      }
      if (clientWidthDescriptor) {
        Object.defineProperty(
          HTMLElement.prototype,
          "clientWidth",
          clientWidthDescriptor,
        );
      }
      if (!clientWidthDescriptor) {
        Reflect.deleteProperty(HTMLElement.prototype, "clientWidth");
      }
    },
    { once: true },
  );
}

export function mockResizeObserver(): { automationAll: () => void } {
  const originalDescriptor = Object.getOwnPropertyDescriptor(
    globalThis,
    "ResizeObserver",
  );
  const observers: TestResizeObserver[] = [];

  class TestResizeObserver implements ResizeObserver {
    private observedTarget: Element | null = null;

    constructor(private readonly callback: ResizeObserverCallback) {
      observers.push(this);
    }

    observe(target: Element): void {
      this.observedTarget = target;
    }

    unobserve(target: Element): void {
      if (this.observedTarget === target) {
        this.observedTarget = null;
      }
    }

    disconnect(): void {
      this.observedTarget = null;
    }

    automation(): void {
      if (!this.observedTarget) {
        return;
      }
      this.callback(
        [
          {
            target: this.observedTarget,
            contentRect: this.observedTarget.getBoundingClientRect(),
            borderBoxSize: [],
            contentBoxSize: [],
            devicePixelContentBoxSize: [],
          } as unknown as ResizeObserverEntry,
        ],
        this,
      );
    }
  }

  Object.defineProperty(globalThis, "ResizeObserver", {
    configurable: true,
    value: TestResizeObserver,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      if (originalDescriptor) {
        Object.defineProperty(globalThis, "ResizeObserver", originalDescriptor);
        return;
      }
      Reflect.deleteProperty(globalThis, "ResizeObserver");
    },
    { once: true },
  );

  return {
    automationAll: () => {
      for (const observer of observers) {
        observer.automation();
      }
    },
  };
}

export function mockFailedAssistantThread({
  threadId,
  error,
}: {
  threadId: string;
  error: string;
}): void {
  mockChatLifecycle(context, {
    threadId,
    threadTitle: "Failed guidance",
    chatMessages: [
      {
        id: `${threadId}-user`,
        role: "user",
        content: "Run the task",
        runId: `${threadId}-run`,
        createdAt: "2026-06-09T10:00:00Z",
      },
      {
        id: `${threadId}-assistant`,
        role: "assistant",
        content: null,
        runId: `${threadId}-run`,
        error,
        runLifecycleEvent: "failed",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
  });
}
