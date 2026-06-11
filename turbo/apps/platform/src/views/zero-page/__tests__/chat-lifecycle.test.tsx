import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadGithubPrsContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type PagedChatMessage,
  type PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_ITEMS,
  VIDEO_STYLE_PRESETS,
} from "@vm0/core";
import {
  zeroBillingCheckoutContract,
  zeroBillingCreditCheckoutContract,
  zeroBillingStatusContract,
} from "@vm0/api-contracts/contracts/zero-billing";
import { zeroComputerUseHostsContract } from "@vm0/api-contracts/contracts/zero-computer-use";
import { zeroUserConnectorsContract } from "@vm0/api-contracts/contracts/user-connectors";
import { FeatureSwitchKey } from "@vm0/connectors/feature-switch-key";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import {
  zeroRunAgentEventsContract,
  zeroRunsByIdContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import { createMockScheduleResponse } from "../../../mocks/handlers/api-schedules.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  mockChatLifecycle,
  mockSubagentThread,
  PLACEHOLDER,
  sendMessageInUI,
  splitChatThreadListResponse,
} from "./chat-test-helpers.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const THREAD_ID = "thread-test-1";
const SCHEDULE_THREAD_ID = "b0000000-0000-4000-a000-000000000701";
const GITHUB_PR_THREAD_ID = "b0000000-0000-4000-a000-000000000702";
const FEEDBACK_THREAD_ID = "b0000000-0000-4000-a000-000000000703";
const FOLLOWUP_THREAD_ID = "b0000000-0000-4000-a000-000000000704";
const HISTORY_THREAD_ID = "b0000000-0000-4000-a000-000000000705";
const CHAT_PATH = `/chats/${THREAD_ID}`;
const AGENT_CHAT_PATH = `/agents/${AGENT_ID}/chat`;

interface QueuedMessageCapture {
  content?: string;
  hasTextContent?: boolean;
  attachments?: PersistedAttachment[];
  clientMessageId: string;
}

interface PushBrowserMock {
  readonly register: ReturnType<typeof vi.fn>;
}

type TestPushManager = Pick<PushManager, "getSubscription" | "subscribe">;

interface TestServiceWorkerRegistration {
  readonly pushManager: TestPushManager;
}

interface TestServiceWorkerContainer {
  readonly register: () => Promise<TestServiceWorkerRegistration>;
}

function mockPushBrowserSupport(): PushBrowserMock {
  vi.stubEnv("VITE_VAPID_PUBLIC_KEY", "AQIDBA");
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

function activeRunTextarea(): Promise<HTMLTextAreaElement> {
  return waitFor(() => {
    return screen.getByPlaceholderText(
      /Type your next message/,
    ) as HTMLTextAreaElement;
  });
}

async function startActiveRun(
  user: ReturnType<typeof userEvent.setup>,
): Promise<HTMLTextAreaElement> {
  const textarea = await waitFor(() => {
    return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
  });
  await sendMessageInUI(user, textarea, "Start the active run");

  await waitFor(() => {
    expect(screen.getByLabelText("Stop")).toBeInTheDocument();
  });

  return activeRunTextarea();
}

async function sendQueuedMessage(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  const textarea = await activeRunTextarea();
  await fill(textarea, text);
  await user.keyboard("{Enter}");
}

async function expectQueuedMessages(contents: string[]): Promise<void> {
  await waitFor(() => {
    const queuedMessages = screen.getAllByLabelText("Queued message");
    expect(queuedMessages).toHaveLength(contents.length);
    for (const [index, content] of contents.entries()) {
      expect(queuedMessages[index]).toHaveTextContent(content);
    }
  });
}

function makeMessage(id: string, text: string): PagedChatMessage {
  return {
    id,
    role: "user",
    content: text,
    createdAt: "2026-05-01T00:00:00Z",
  };
}

function mockKeyboardNavigationThreads(): void {
  const threadFixtures = [
    {
      id: "keyboard-prev-thread",
      title: "Previous keyboard thread",
      message: "Previous thread launch note",
    },
    {
      id: "keyboard-current-thread",
      title: "Current keyboard thread",
      message: "Current thread launch note",
    },
    {
      id: "keyboard-next-thread",
      title: "Next keyboard thread",
      message: "Next thread launch note",
    },
  ];
  const byId = new Map(
    threadFixtures.map((thread) => {
      return [thread.id, thread];
    }),
  );

  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(
      200,
      splitChatThreadListResponse(
        threadFixtures.map((thread, index) => {
          return {
            id: thread.id,
            title: thread.title,
            agent: { id: AGENT_ID, avatarUrl: null },
            createdAt: "2026-06-01T00:00:00Z",
            updatedAt: `2026-06-01T00:0${index}:00Z`,
            isRead: true,
            running: false,
            pinnedAt: null,
          };
        }),
      ),
    );
  });
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    const thread = byId.get(params.id);
    if (!thread) {
      return respond(404, {
        error: { message: "Thread not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      id: thread.id,
      title: thread.title,
      agentId: AGENT_ID,
      activeRunIds: [],
      createdAt: "2026-06-01T00:00:00Z",
      updatedAt: "2026-06-01T00:00:00Z",
      draftContent: null,
      draftAttachments: null,
    });
  });
  context.mocks.api(
    chatThreadMessagesContract.list,
    ({ params, query, respond }) => {
      if (query.sinceId) {
        return respond(200, { messages: [] });
      }
      const thread = byId.get(params.threadId);
      return respond(200, {
        messages: thread
          ? [
              {
                id: `${thread.id}-message`,
                role: "user",
                content: thread.message,
                createdAt: "2026-06-01T00:00:00Z",
              },
            ]
          : [],
        hasHistoryBefore: false,
      });
    },
  );
}

function mockActiveRunThread(threadId: string): void {
  mockChatLifecycle(context, {
    threadId,
    chatMessages: [
      {
        id: `${threadId}-active-user`,
        role: "user",
        content: "Start the active run",
        runId: "run-active",
        createdAt: "2026-06-09T10:00:00Z",
      },
      {
        id: `${threadId}-active-assistant`,
        role: "assistant",
        content: null,
        runId: "run-active",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
    activeRunIds: ["run-active"],
  });
}

function mockScheduleThread(): void {
  mockChatLifecycle(context, {
    threadId: SCHEDULE_THREAD_ID,
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
  context.mocks.data.schedules([
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000701",
      agentId: AGENT_ID,
      chatThreadId: SCHEDULE_THREAD_ID,
      name: "launch-review",
      description: "Launch review",
      prompt: "Review launch risks",
      cronExpression: "30 15 * * 1-5",
      triggerType: "cron",
      nextRunAt: "2026-06-10T15:30:00.000Z",
    }),
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000702",
      agentId: AGENT_ID,
      chatThreadId: SCHEDULE_THREAD_ID,
      name: "paused-launch-audit",
      description: "Paused launch audit",
      prompt: "Audit launch readiness",
      cronExpression: "0 12 * * 1",
      triggerType: "cron",
      enabled: false,
      nextRunAt: null,
    }),
    createMockScheduleResponse({
      id: "f0000001-0000-4000-a000-000000000703",
      agentId: AGENT_ID,
      chatThreadId: SCHEDULE_THREAD_ID,
      name: "manual-launch-reminder",
      description: "Manual launch reminder",
      prompt: "Remind the team about launch blockers",
      cronExpression: "0 18 * * 5",
      triggerType: "cron",
      nextRunAt: null,
    }),
  ]);
}

function mockServerQueuedThreadStories(): void {
  const threads = [
    {
      id: "thread-server-queued-visible",
      title: "Server queued run",
      messages: [
        {
          id: "msg-server-queued-visible-user",
          role: "user" as const,
          content: "Start queued deployment",
          runId: "run-server-queued-visible",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-server-queued-visible-marker",
          role: "assistant" as const,
          content: null,
          runId: "run-server-queued-visible",
          runEventId: "queue:queued",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ] satisfies PagedChatMessage[],
      activeRunIds: ["run-server-queued-visible"],
    },
    {
      id: "thread-server-queued-resolved",
      title: "Resolved server queue",
      messages: [
        {
          id: "msg-server-queued-resolved-user",
          role: "user" as const,
          content: "Watch queued deployment resolve",
          runId: "run-server-queued-resolved",
          createdAt: "2026-06-09T10:05:00Z",
        },
        {
          id: "msg-server-queued-resolved-marker",
          role: "assistant" as const,
          content: null,
          runId: "run-server-queued-resolved",
          runEventId: "queue:queued",
          createdAt: "2026-06-09T10:05:01Z",
        },
        {
          id: "msg-server-queued-resolved-assistant",
          role: "assistant" as const,
          content: "Queued deployment is running now.",
          runId: "run-server-queued-resolved",
          createdAt: "2026-06-09T10:05:02Z",
        },
        {
          id: "msg-server-queued-resolved-completed",
          role: "assistant" as const,
          content: null,
          runId: "run-server-queued-resolved",
          runLifecycleEvent: "completed" as const,
          createdAt: "2026-06-09T10:05:03Z",
        },
      ] satisfies PagedChatMessage[],
      activeRunIds: [],
    },
  ];
  const byId = new Map(
    threads.map((thread) => {
      return [thread.id, thread];
    }),
  );

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
  context.mocks.api(chatThreadsContract.list, ({ respond }) => {
    return respond(
      200,
      splitChatThreadListResponse(
        threads.map((thread, index) => {
          return {
            id: thread.id,
            title: thread.title,
            agent: { id: AGENT_ID, avatarUrl: null },
            createdAt: "2026-06-09T10:00:00Z",
            updatedAt: `2026-06-09T10:0${index}:00Z`,
            isRead: true,
            running: thread.activeRunIds.length > 0,
            pinnedAt: null,
          };
        }),
      ),
    );
  });
  context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
    const thread = byId.get(params.id);
    if (!thread) {
      return respond(404, {
        error: { message: "Thread not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, {
      id: thread.id,
      title: thread.title,
      agentId: AGENT_ID,
      activeRunIds: thread.activeRunIds,
      createdAt: "2026-06-09T10:00:00Z",
      updatedAt: "2026-06-09T10:00:00Z",
      draftContent: null,
      draftAttachments: null,
    });
  });
  context.mocks.api(
    chatThreadMessagesContract.list,
    ({ params, query, respond }) => {
      if (query.sinceId || query.beforeId) {
        return respond(200, { messages: [] });
      }
      return respond(200, {
        messages: byId.get(params.threadId)?.messages ?? [],
        hasHistoryBefore: false,
      });
    },
  );
  context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
    return respond(200, { lastReadMessageId: null, changed: false });
  });
}

function mockGithubPrTrackingThread(): void {
  mockChatLifecycle(context, {
    threadId: GITHUB_PR_THREAD_ID,
    threadTitle: "PR review",
    chatMessages: [
      {
        id: "msg-pr-request",
        role: "user",
        content: "Review the failing pull request",
        createdAt: "2026-06-09T10:00:00Z",
      },
    ],
  });
  context.mocks.data.connectors([
    {
      id: "99999999-9999-4999-8999-999999999999",
      type: "github",
      authMethod: "oauth",
      externalId: "github-octocat",
      externalUsername: "octocat",
      externalEmail: null,
      oauthScopes: ["repo"],
      connectionStatus: "connected",
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]);
  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration({
      labelListeners: [
        {
          id: "b0000000-0000-4000-a000-000000000701",
          labelName: "needs-review",
          triggerMode: "created_by_me",
          prompt: "Review the labeled pull request.",
          enabled: true,
          canManage: true,
          agent: {
            id: AGENT_ID,
            name: "zero",
          },
          createdAt: "2026-06-09T10:00:00Z",
          updatedAt: "2026-06-09T10:00:00Z",
        },
      ],
    }),
  );
  context.mocks.api(zeroUserConnectorsContract.get, ({ respond }) => {
    return respond(200, { enabledTypes: ["github"] });
  });
  context.mocks.api(chatThreadGithubPrsContract.list, ({ respond }) => {
    return respond(200, {
      prs: [
        {
          repo: "vm0-ai/vm0",
          number: 123,
          title: "Fix flaky platform tests",
          url: "https://github.com/vm0-ai/vm0/pull/123",
          state: "open",
          headSha: "abc123",
          mergeStatus: "conflicts",
          rollup: "failure",
          checks: [
            {
              name: "unit tests",
              status: "completed",
              conclusion: "failure",
              url: "https://github.com/vm0-ai/vm0/actions/runs/1",
              startedAt: "2026-06-09T10:00:00Z",
              completedAt: "2026-06-09T10:05:00Z",
            },
            {
              name: "deploy preview",
              status: "queued",
              conclusion: null,
              url: null,
              startedAt: null,
              completedAt: null,
            },
          ],
        },
        {
          repo: "vm0-ai/vm0",
          number: 124,
          title: "Stabilize deploy preview checks",
          url: "https://github.com/vm0-ai/vm0/pull/124",
          state: "open",
          headSha: "def456",
          mergeStatus: "blocked",
          rollup: "pending",
          checks: [
            {
              name: "lint",
              status: "completed",
              conclusion: "success",
              url: "https://github.com/vm0-ai/vm0/actions/runs/2",
              startedAt: "2026-06-09T10:06:00Z",
              completedAt: "2026-06-09T10:07:00Z",
            },
            {
              name: "security review",
              status: "in_progress",
              conclusion: null,
              url: null,
              startedAt: "invalid-date",
              completedAt: null,
            },
          ],
        },
        {
          repo: "vm0-ai/vm0",
          number: 125,
          title: "Draft data cleanup",
          url: "https://github.com/vm0-ai/vm0/pull/125",
          state: "open",
          headSha: "ghi789",
          mergeStatus: "draft",
          rollup: "none",
          checks: [],
        },
        {
          repo: "vm0-ai/vm0",
          number: 126,
          title: "Ready coverage update",
          url: "https://github.com/vm0-ai/vm0/pull/126",
          state: "open",
          headSha: "jkl012",
          mergeStatus: "ready",
          rollup: "success",
          checks: [
            {
              name: "coverage",
              status: "completed",
              conclusion: "success",
              url: "https://github.com/vm0-ai/vm0/actions/runs/3",
              startedAt: "2026-06-09T10:08:00Z",
              completedAt: "2026-06-09T10:11:00Z",
            },
          ],
        },
        {
          repo: "vm0-ai/vm0",
          number: 127,
          title: "External checks unavailable",
          url: "https://github.com/vm0-ai/vm0/pull/127",
          state: "open",
          headSha: "mno345",
          mergeStatus: null,
          rollup: "unknown",
          checks: [],
        },
      ],
    });
  });
}

async function openGithubPrTracking(): Promise<void> {
  click(await screen.findByLabelText("Open GitHub PR tracking"));

  await waitFor(() => {
    expect(screen.getByLabelText("GitHub PR tracking")).toBeInTheDocument();
  });
}

function setupGithubPrTrackingPage(): void {
  mockGithubPrTrackingThread();
  detachedSetupPage({
    context,
    path: `/chats/${GITHUB_PR_THREAD_ID}`,
    featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
  });
}

function selectTextForInlineFeedback(element: HTMLElement): void {
  const range = document.createRange();
  range.selectNodeContents(element);
  Object.defineProperty(range, "getBoundingClientRect", {
    configurable: true,
    value: () => {
      return new DOMRect(24, 32, 180, 20);
    },
  });

  const selection = window.getSelection();
  if (!selection) {
    throw new Error("Selection API is not available");
  }
  selection.removeAllRanges();
  selection.addRange(range);
  document.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
}

function buttonByText(text: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

function queryButtonByText(text: string): HTMLElement | null {
  return (
    queryAllByRoleFast("button").find((candidate) => {
      return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
    }) ?? null
  );
}

function chatScrollContainer(): HTMLElement {
  const element = document.querySelector("[data-scroll-container]");
  if (!(element instanceof HTMLElement)) {
    throw new Error("Chat scroll container not found");
  }
  return element;
}

function setScrollMetrics(
  element: HTMLElement,
  metrics: { scrollHeight: number; clientHeight: number },
): void {
  Object.defineProperties(element, {
    scrollHeight: { configurable: true, value: metrics.scrollHeight },
    clientHeight: { configurable: true, value: metrics.clientHeight },
  });
}

function mockResizeObserver(): { triggerAll: () => void } {
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

    trigger(): void {
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
    triggerAll: () => {
      for (const observer of observers) {
        observer.trigger();
      }
    },
  };
}

function mockFailedAssistantThread({
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

describe("chat lifecycle", () => {
  it("shows a sent message and stop control while a new chat run is active", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Summarize the launch plan");

    await waitFor(() => {
      expect(screen.getByText("Summarize the launch plan")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("subscribes the browser for push notifications after a visible chat send", async () => {
    const user = userEvent.setup({ delay: null });
    const pushBrowser = mockPushBrowserSupport();
    let capturedSubscription: unknown;
    context.mocks.http.post(
      "*/api/zero/push-subscriptions",
      async ({ request }) => {
        capturedSubscription = await request.json();
        return new Response(null, { status: 204 });
      },
    );
    mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    await waitFor(() => {
      expect(pushBrowser.register).toHaveBeenCalledWith("/sw.js", {
        updateViaCache: "none",
      });
    });
    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Notify me when this run finishes");

    await waitFor(() => {
      expect(
        screen.getByText("Notify me when this run finishes"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(capturedSubscription).toStrictEqual({
        endpoint: "https://push.example.test/subscriptions/chat-send",
        keys: {
          p256dh: "AQID",
          auth: "BAUG",
        },
      });
    });
  });

  it("starts a new chat with a visual attachment", async () => {
    const user = userEvent.setup({ delay: null });
    context.mocks.data.userModelPreference({
      selectedModel: "claude-sonnet-4-6",
      updatedAt: "2026-03-10T00:00:00Z",
    });
    mockChatLifecycle(context);
    context.mocks.upload.success({
      id: "upload-visual-brief",
      filename: "brief.png",
      contentType: "image/png",
      size: 128,
      url: "https://cdn.vm7.io/artifacts/test/upload-visual-brief/brief.png",
    });

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }

    await user.upload(
      fileInput,
      new File(["image-bytes"], "brief.png", { type: "image/png" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove brief.png")).toBeInTheDocument();
    });

    await sendMessageInUI(user, textarea, "Summarize this visual brief");

    await waitFor(() => {
      expect(
        screen.getByText("Summarize this visual brief"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("renders completed markdown and returns the composer to send mode", async () => {
    const user = userEvent.setup({ delay: null });
    const lifecycle = mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Summarize the launch plan");

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    lifecycle.completeRun("Here is the **result**");

    await waitFor(() => {
      expect(screen.getByText("result")).toBeInTheDocument();
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });

  it("recalls a queued follow-up while an optimistic new thread settles", async () => {
    const user = userEvent.setup({ delay: null });
    const sendGate = context.mocks.deferred<void>();
    mockChatLifecycle(context, { sendGate: sendGate.promise });

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "First new-thread message");

    await waitFor(() => {
      expect(screen.getByText("First new-thread message")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await sendQueuedMessage(user, "First queued follow-up");
    await expectQueuedMessages(["First queued follow-up"]);

    click(screen.getAllByLabelText("Remove queued message")[0]!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your next message/)).toHaveValue(
        "First queued follow-up",
      );
    });

    sendGate.resolve();

    await waitFor(() => {
      expect(screen.getByText("First new-thread message")).toBeInTheDocument();
    });
  });

  it("keeps optimistic new-thread follow-ups queued after the first send resolves", async () => {
    const user = userEvent.setup({ delay: null });
    const sendGate = context.mocks.deferred<void>();
    const queuedBodies: QueuedMessageCapture[] = [];
    mockChatLifecycle(context, {
      sendGate: sendGate.promise,
      onQueuedMessageAppend: (body) => {
        queuedBodies.push(body);
      },
    });
    context.mocks.upload.success({
      id: "upload-optimistic-notes",
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
      url: "https://cdn.vm7.io/artifacts/test/upload-optimistic-notes/notes.txt",
    });

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Start the optimistic thread");

    await waitFor(() => {
      expect(
        screen.getByText("Start the optimistic thread"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await sendQueuedMessage(user, "Add the launch checklist");
    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }
    await user.upload(
      fileInput,
      new File(["launch notes"], "notes.txt", { type: "text/plain" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove notes.txt")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Send"));

    await expectQueuedMessages([
      "Add the launch checklist",
      "(see attached files)",
    ]);

    sendGate.resolve();

    await waitFor(() => {
      expect(
        screen.getByText("Start the optimistic thread"),
      ).toBeInTheDocument();
      expect(queuedBodies).toHaveLength(2);
      expect(queuedBodies[1]).toMatchObject({
        content: "(see attached files)",
        hasTextContent: false,
        attachments: [
          {
            id: "upload-optimistic-notes",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 12,
            url: "https://cdn.vm7.io/artifacts/test/upload-optimistic-notes/notes.txt",
          },
        ],
      });
    });
    await expectQueuedMessages([
      "Add the launch checklist",
      "(see attached files)",
    ]);
  });

  it("replays recalled queued content during an active run", async () => {
    const user = userEvent.setup({ delay: null });
    mockActiveRunThread(THREAD_ID);

    detachedSetupPage({ context, path: CHAT_PATH });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    await sendQueuedMessage(user, "First queued follow-up");
    await sendQueuedMessage(user, "Second queued follow-up");
    await expectQueuedMessages([
      "First queued follow-up",
      "Second queued follow-up",
    ]);

    click(screen.getAllByLabelText("Remove queued message")[0]!);

    await waitFor(() => {
      expect(screen.getByPlaceholderText(/Type your next message/)).toHaveValue(
        "First queued follow-up",
      );
    });

    await fill(
      screen.getByPlaceholderText(/Type your next message/),
      "Replayed follow-up",
    );
    await user.keyboard("{Enter}");

    await expectQueuedMessages([
      "Second queued follow-up",
      "Replayed follow-up",
    ]);
  });

  it("queues an attachment-only follow-up during an active run", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-attachment-only-active";
    let queuedBody: QueuedMessageCapture | null = null;

    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-active-attachment-user",
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-active-attachment-assistant",
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
      onQueuedMessageAppend: (body) => {
        queuedBody = body;
      },
    });
    context.mocks.upload.success({
      id: "upload-notes",
      filename: "notes.txt",
      contentType: "text/plain",
      size: 12,
      url: "https://cdn.vm7.io/artifacts/test/upload-notes/notes.txt",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    const fileInput =
      document.querySelector<HTMLInputElement>('input[type="file"]');
    if (!fileInput) {
      throw new Error("file input not found");
    }
    await user.upload(
      fileInput,
      new File(["release note"], "notes.txt", { type: "text/plain" }),
    );

    await waitFor(() => {
      expect(screen.getByLabelText("Remove notes.txt")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Send"));

    await waitFor(() => {
      expect(screen.getByText("1 message waiting to send")).toBeInTheDocument();
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "(see attached files)",
      );
      expect(queuedBody).toMatchObject({
        content: "(see attached files)",
        hasTextContent: false,
        attachments: [
          {
            id: "upload-notes",
            filename: "notes.txt",
            contentType: "text/plain",
            size: 12,
            url: "https://cdn.vm7.io/artifacts/test/upload-notes/notes.txt",
          },
        ],
      });
    });
  });

  it("recalls queued content and clears the thinking indicator when the active run is stopped", async () => {
    const user = userEvent.setup({ delay: null });
    mockChatLifecycle(context, { threadId: THREAD_ID });

    detachedSetupPage({ context, path: CHAT_PATH });

    await startActiveRun(user);
    await sendQueuedMessage(user, "First queued");
    await sendQueuedMessage(user, "Second queued");
    await expectQueuedMessages(["First queued", "Second queued"]);

    click(screen.getByLabelText("Stop"));

    await waitFor(() => {
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeInTheDocument();
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
    });
  });

  it("stops a server-queued run and recalls queued follow-up messages", async () => {
    const interrupts: string[] = [];
    const recalls: string[] = [];
    mockChatLifecycle(context, {
      threadId: "thread-server-queued-run",
      chatMessages: [
        {
          id: "msg-server-queued-user",
          role: "user",
          content: "Start the server queued run",
          runId: "run-server-queued",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-server-queue-marker",
          role: "assistant",
          content: null,
          runId: "run-server-queued",
          runEventId: "queue:queued",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-server-queued-followup",
          role: "user",
          content: "Follow up when the queued run starts",
          runId: undefined,
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      onInterruptMessageAppend: (body) => {
        interrupts.push(body.interruptsRunId);
      },
      onRecallMessageAppend: (body) => {
        recalls.push(body.revokesMessageId);
      },
      activeRunIds: ["run-server-queued"],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-server-queued-run",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Start the server queued run"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Follow up when the queued run starts"),
      ).toBeInTheDocument();
      expect(screen.getByText("1 message waiting to send")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Stop"));

    await waitFor(() => {
      expect(interrupts).toContain("run-server-queued");
      expect(recalls).toContain("msg-server-queued-followup");
      expect(screen.queryByLabelText("Queued message")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });

  it("shows server queue state only while the queue marker is unresolved", async () => {
    mockServerQueuedThreadStories();

    detachedSetupPage({
      context,
      path: "/chats/thread-server-queued-visible",
    });

    await waitFor(() => {
      expect(screen.getByText("Start queued deployment")).toBeInTheDocument();
      expect(screen.getByText("queue...")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    click(screen.getByText("Resolved server queue"));

    await waitFor(() => {
      expect(
        screen.getByText("Queued deployment is running now."),
      ).toBeInTheDocument();
      expect(screen.queryByText("queue...")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });

  it("keeps completed chat work visible when folding is disabled", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-disabled",
      chatMessages: [
        {
          role: "user",
          content: "Audit the launch checklist",
          runId: "run-work-folding-disabled",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "The launch checklist is ready.",
          runId: "run-work-folding-disabled",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:55Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-disabled",
      featureSwitches: { [FeatureSwitchKey.ChatCompletedWorkFolding]: false },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Audit the launch checklist"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("The launch checklist is ready."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("keeps chat work visible while the run is active", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-running",
      activeRunIds: ["run-work-folding-running"],
      chatMessages: [
        {
          role: "user",
          content: "Draft the launch checklist",
          runId: "run-work-folding-running",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking the remaining launch steps.",
          runId: "run-work-folding-running",
          createdAt: "2026-06-09T10:00:20Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-running",
      featureSwitches: { [FeatureSwitchKey.ChatCompletedWorkFolding]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Draft the launch checklist"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Checking the remaining launch steps."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("folds completed chat work and toggles the hidden history", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-completed",
      chatMessages: [
        {
          role: "user",
          content: "Summarize the launch status",
          runId: "run-work-folding-completed",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Launch status is summarized.",
          runId: "run-work-folding-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:55Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-completed",
      featureSwitches: { [FeatureSwitchKey.ChatCompletedWorkFolding]: true },
    });

    const expandButton = await screen.findByLabelText("Expand work history");
    expect(expandButton).toHaveTextContent("Worked for 55s");
    expect(screen.queryByText("Summarize the launch status")).toBeNull();
    expect(
      screen.getByText("Launch status is summarized."),
    ).toBeInTheDocument();

    click(expandButton);

    await waitFor(() => {
      expect(
        screen.getByText("Summarize the launch status"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Collapse work history")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    click(screen.getByLabelText("Collapse work history"));

    await waitFor(() => {
      expect(screen.queryByText("Summarize the launch status")).toBeNull();
      expect(screen.getByLabelText("Expand work history")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
  });

  it("renders a server-corrected assistant message without the stale answer", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-corrected-answer",
      threadTitle: "Corrected answer",
      chatMessages: [
        {
          id: "msg-corrected-user",
          role: "user",
          content: "Summarize the launch plan",
          runId: "run-corrected-answer",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-stale-answer",
          role: "assistant",
          content: "Use the old launch plan.",
          runId: "run-corrected-answer",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-new-answer",
          role: "assistant",
          content: "Use the revised launch plan with updated owners.",
          runId: "run-corrected-answer",
          revokesMessageId: "msg-stale-answer",
          createdAt: "2026-06-09T10:02:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-corrected-answer",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Use the revised launch plan with updated owners."),
      ).toBeInTheDocument();
      expect(
        screen.queryByText("Use the old launch plan."),
      ).not.toBeInTheDocument();
    });
  });

  it("restores an interrupted run without duplicate cancellation rows", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-restored-interrupt",
      threadTitle: "Restored interrupt",
      chatMessages: [
        {
          id: "msg-interrupted-user",
          role: "user",
          content: "Start a long task",
          runId: "run-restored-interrupt",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-interrupted-assistant",
          role: "assistant",
          content: null,
          runId: "run-restored-interrupt",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-interrupt-control",
          role: "user",
          content: null,
          interruptsRunId: "run-restored-interrupt",
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-server-cancelled",
          role: "assistant",
          content: "Run cancelled",
          runId: "run-restored-interrupt",
          error: "Run cancelled",
          runLifecycleEvent: "cancelled",
          createdAt: "2026-06-09T10:03:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-restored-interrupt",
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("Paused mid-thought — pick it back up whenever."),
      ).toHaveLength(1);
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });

  it("catches up after realtime bursts and keeps the latest burst message visible", async () => {
    const threadId = "catchup-thread";
    const baselineMessages = Array.from({ length: 5 }, (_, index) => {
      return makeMessage(`base-${index}`, `Baseline ${index}`);
    });
    const burstMessages = Array.from({ length: 120 }, (_, index) => {
      return makeMessage(`burst-${index}`, `Burst ${index}`);
    });
    let page = 0;

    mockSubagentThread(context, threadId);
    context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: threadId,
        title: null,
        agentId: AGENT_ID,
        activeRunIds: [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-05-01T00:00:00Z",
        updatedAt: "2026-05-01T00:00:00Z",
      });
    });
    context.mocks.api(chatThreadMessagesContract.list, ({ query, respond }) => {
      if (!query.sinceId) {
        return respond(200, {
          messages: baselineMessages,
          hasHistoryBefore: false,
        });
      }
      const startIndex = page * 50;
      page += 1;
      return respond(200, {
        messages: burstMessages.slice(startIndex, startIndex + 50),
      });
    });
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
      return respond(200, { lastReadMessageId: null, changed: false });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Baseline 0")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Burst 119")).toBeInTheDocument();
    });
  });

  it("loads older chat history from the thread control", async () => {
    const olderReply = "Earlier launch notes from last week.";

    mockChatLifecycle(context, {
      threadId: HISTORY_THREAD_ID,
      threadTitle: "History review",
      historyMessages: [
        {
          role: "assistant",
          content: olderReply,
          runId: undefined,
          createdAt: "2026-06-02T10:00:00Z",
        },
      ],
      chatMessages: [
        {
          role: "user",
          content: "Continue the launch review",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Current launch risks are ready.",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${HISTORY_THREAD_ID}` });

    await waitFor(() => {
      expect(
        screen.getByText("Current launch risks are ready."),
      ).toBeInTheDocument();
      expect(buttonByText("Load history")).toBeInTheDocument();
    });
    expect(screen.queryByText(olderReply)).not.toBeInTheDocument();

    click(buttonByText("Load history"));

    await waitFor(() => {
      expect(screen.getByText(olderReply)).toBeInTheDocument();
      expect(queryButtonByText("Load history")).not.toBeInTheDocument();
    });
  });

  it("keeps chat scroll controls visible while browsing older messages", async () => {
    const resizeObserver = mockResizeObserver();
    const olderReply = "Scroll back to the planning notes.";
    mockChatLifecycle(context, {
      threadId: "scroll-history-thread",
      threadTitle: "Scroll history",
      historyMessages: [
        {
          role: "assistant",
          content: olderReply,
          runId: undefined,
          createdAt: "2026-06-02T10:00:00Z",
        },
      ],
      chatMessages: Array.from({ length: 8 }, (_, index) => {
        return makeMessage(
          `scroll-message-${index}`,
          `Visible launch update ${index}`,
        );
      }),
    });

    detachedSetupPage({ context, path: "/chats/scroll-history-thread" });

    await waitFor(() => {
      expect(screen.getByText("Visible launch update 7")).toBeInTheDocument();
      expect(buttonByText("Load history")).toBeInTheDocument();
    });

    const scrollContainer = chatScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1200,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 900;
    fireEvent.scroll(scrollContainer);
    fireEvent.wheel(scrollContainer);
    scrollContainer.scrollTop = 520;
    fireEvent.scroll(scrollContainer);

    const scrollToBottom = await screen.findByLabelText("Scroll to bottom");
    click(scrollToBottom);
    expect(scrollContainer.scrollTop).toBe(1200);
    fireEvent.scroll(scrollContainer);
    await waitFor(() => {
      expect(screen.queryByLabelText("Scroll to bottom")).toBeNull();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "ArrowUp", ctrlKey: true });
    expect(scrollContainer.scrollTop).toBe(0);
    fireEvent.scroll(scrollContainer);
    await waitFor(() => {
      expect(screen.getByLabelText("Scroll to bottom")).toBeInTheDocument();
    });

    scrollContainer.scrollTop = 420;
    const composer = screen.getByPlaceholderText(PLACEHOLDER);
    composer.focus();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(scrollContainer.scrollTop).toBe(420);

    click(buttonByText("Load history"));
    await waitFor(() => {
      expect(screen.getByText(olderReply)).toBeInTheDocument();
    });

    setScrollMetrics(scrollContainer, {
      scrollHeight: 1500,
      clientHeight: 300,
    });
    resizeObserver.triggerAll();
    expect(scrollContainer.scrollTop).toBe(720);

    fireEvent.keyDown(threadRegion, { key: "ArrowDown", ctrlKey: true });
    expect(scrollContainer.scrollTop).toBe(1500);
  });

  it("moves between chat threads with keyboard shortcuts", async () => {
    const resizeObserver = mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByText("Previous keyboard thread")).toBeInTheDocument();
      expect(screen.getByText("Next keyboard thread")).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    const initialScrollContainer = chatScrollContainer();
    setScrollMetrics(initialScrollContainer, {
      scrollHeight: 1200,
      clientHeight: 300,
    });
    initialScrollContainer.scrollTop = 900;
    fireEvent.scroll(initialScrollContainer);
    fireEvent.wheel(initialScrollContainer);
    initialScrollContainer.scrollTop = 480;
    fireEvent.scroll(initialScrollContainer);
    await waitFor(() => {
      expect(screen.getByLabelText("Scroll to bottom")).toBeInTheDocument();
    });

    threadRegion.focus();
    fireEvent.keyDown(threadRegion, {
      key: "ArrowUp",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Previous thread launch note"),
      ).toBeInTheDocument();
    });

    const previousThreadRegion = screen.getByLabelText("Chat thread");
    previousThreadRegion.focus();
    fireEvent.keyDown(previousThreadRegion, {
      key: "ArrowDown",
      ctrlKey: true,
      shiftKey: true,
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });

    const restoredScrollContainer = chatScrollContainer();
    setScrollMetrics(restoredScrollContainer, {
      scrollHeight: 1200,
      clientHeight: 300,
    });
    resizeObserver.triggerAll();
    expect(restoredScrollContainer.scrollTop).toBe(480);
    expect(screen.getByLabelText("Scroll to bottom")).toBeInTheDocument();

    const currentThreadRegion = screen.getByLabelText("Chat thread");
    currentThreadRegion.focus();
    fireEvent.keyDown(currentThreadRegion, { key: "?", shiftKey: true });

    await waitFor(() => {
      expect(screen.getByText("Keyboard Shortcuts")).toBeInTheDocument();
      expect(screen.getByText("Previous thread")).toBeInTheDocument();
      expect(screen.getByText("Next thread")).toBeInTheDocument();
    });
  });

  it("opens run logs from assistant message actions", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "message-run-logs-thread";
    const runId = "a0000000-0000-4000-a000-000000000001";
    const assistantReply = "The launch summary is ready to share.";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Run logs message",
      chatMessages: [
        {
          id: "msg-run-logs-user",
          role: "user",
          content: "Summarize the launch update",
          runId,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-run-logs-assistant",
          role: "assistant",
          content: assistantReply,
          runId,
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(assistantReply)).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("View run logs"));

    await waitFor(() => {
      expect(screen.getByRole("heading", { name: "zero" })).toBeInTheDocument();
      expect(screen.getByText("Steps")).toBeInTheDocument();
    });
  });

  it("copies an assistant response from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWriteText();
    const threadId = "assistant-copy-thread";
    const assistantReply = "The launch summary is ready to share.";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Assistant copy",
      chatMessages: [
        {
          id: "msg-assistant-copy-user",
          role: "user",
          content: "Summarize the launch update",
          runId: "run-assistant-copy",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-assistant-copy-response",
          role: "assistant",
          content: assistantReply,
          runId: "run-assistant-copy",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(assistantReply)).toBeInTheDocument();
    });

    const assistantGroup = screen
      .getByText(assistantReply)
      .closest('[data-role="assistant"]');
    if (!(assistantGroup instanceof HTMLElement)) {
      throw new Error("assistant message group not found");
    }
    click(within(assistantGroup).getByLabelText("Copy message"));

    await waitFor(() => {
      expect(clipboard.writes).toStrictEqual([assistantReply]);
    });
  });

  it("shows linked schedules from the chat header", async () => {
    mockScheduleThread();

    detachedSetupPage({ context, path: `/chats/${SCHEDULE_THREAD_ID}` });

    await waitFor(() => {
      expect(screen.getByText("Scheduled launch review")).toBeInTheDocument();
      expect(screen.getByLabelText("Schedules")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Schedules"));

    await waitFor(() => {
      expect(screen.getByText("Launch review")).toBeInTheDocument();
      expect(screen.getByText(/Next run/u)).toBeInTheDocument();
      expect(screen.getByText("Paused launch audit")).toBeInTheDocument();
      expect(screen.getByText("Schedule inactive")).toBeInTheDocument();
      expect(screen.getByText("Manual launch reminder")).toBeInTheDocument();
      expect(screen.getByText("No upcoming run")).toBeInTheDocument();
    });
  });

  it("opens a linked schedule detail from the chat header", async () => {
    mockScheduleThread();

    detachedSetupPage({ context, path: `/chats/${SCHEDULE_THREAD_ID}` });

    click(await screen.findByLabelText("Schedules"));

    await waitFor(() => {
      expect(screen.getByText("Launch review")).toBeInTheDocument();
    });

    click(screen.getByText("Launch review"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Launch review" }),
      ).toBeInTheDocument();
    });
  });

  it("shows scheduled run messages as schedule links in chat history", async () => {
    const threadId = "thread-scheduled-message";
    const scheduleId = "f0000001-0000-4000-a000-000000000721";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Scheduled message",
      chatMessages: [
        {
          id: "msg-scheduled-user",
          role: "user",
          content: "Review launch risks",
          scheduleId,
          scheduleSnapshot: {
            id: scheduleId,
            title: "Launch risk review",
            description: "Launch review",
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-scheduled-assistant",
          role: "assistant",
          content: "I'll review the launch risks on schedule.",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Scheduled message")).toBeInTheDocument();
      expect(screen.getByText("Launch review")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open schedule Launch review"),
      ).toHaveAttribute("href", `/schedules/${scheduleId}`);
      expect(screen.queryByText("Review launch risks")).not.toBeInTheDocument();
    });
  });

  it("shows template labels on historical user messages", async () => {
    const threadId = "template-message-history";
    const presentationTemplate = PRESENTATION_TEMPLATE_ITEMS[0]!;
    const videoTemplate = VIDEO_STYLE_PRESETS[0]!;
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Template labels",
      chatMessages: [
        {
          id: "msg-template-presentation",
          role: "user",
          content: "Create the business review deck",
          runId: "run-template-presentation",
          generationTemplate: {
            type: "presentation",
            selection: {
              designSystemId: presentationTemplate.designSystemId,
              templateId: presentationTemplate.templateId,
            },
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-template-video",
          role: "user",
          content: "Create a product walkthrough video",
          runId: "run-template-video",
          generationTemplate: {
            type: "video",
            selection: { stylePresetId: videoTemplate.id },
          },
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-template-illustration",
          role: "user",
          content: "Create an illustrated launch card",
          runId: "run-template-illustration",
          generationTemplate: {
            type: "illustration",
            selection: {
              illustrationStyleId: illustrationTemplate.illustrationStyleId,
            },
          },
          createdAt: "2026-06-09T10:02:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: true,
        [FeatureSwitchKey.VideoTemplatePicker]: true,
      },
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Message template ${presentationTemplate.title}`),
      ).toHaveTextContent("Slides");
      expect(
        screen.getByLabelText(`Message template ${videoTemplate.nameEn}`),
      ).toHaveTextContent("Video");
      expect(
        screen.getByLabelText(`Message template ${illustrationTemplate.title}`),
      ).toHaveTextContent("Illustration");
    });
  });

  it("hides historical template labels behind picker feature switches", async () => {
    const threadId = "template-message-history-gated";
    const presentationTemplate = PRESENTATION_TEMPLATE_ITEMS[0]!;
    const illustrationTemplate = ILLUSTRATION_TEMPLATE_ITEMS[0]!;

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Template labels gated",
      chatMessages: [
        {
          id: "msg-template-presentation-gated",
          role: "user",
          content: "Create the business review deck",
          runId: "run-template-presentation-gated",
          generationTemplate: {
            type: "presentation",
            selection: {
              designSystemId: presentationTemplate.designSystemId,
              templateId: presentationTemplate.templateId,
            },
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-template-illustration-gated",
          role: "user",
          content: "Create an illustrated launch card",
          runId: "run-template-illustration-gated",
          generationTemplate: {
            type: "illustration",
            selection: {
              illustrationStyleId: illustrationTemplate.illustrationStyleId,
            },
          },
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatTemplatePicker]: false,
      },
    });

    await waitFor(() => {
      expect(screen.getByText("Create the business review deck")).toBeVisible();
      expect(
        screen.queryByLabelText(
          `Message template ${presentationTemplate.title}`,
        ),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByLabelText(
          `Message template ${illustrationTemplate.title}`,
        ),
      ).not.toBeInTheDocument();
    });
  });

  it("copies a user message with legacy inline attachments from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "legacy-attachment-copy";
    const imageUrl = "/f/test-user/attachment-chart/chart.png";
    const videoUrl = "/f/test-user/attachment-demo/demo.mp4";
    const audioUrl = "/f/test-user/attachment-briefing/briefing.mp3";
    const markdownUrl = "/f/test-user/attachment-notes/notes.md";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-legacy-attachments",
          role: "user",
          content: [
            "Review the launch assets",
            `[Attached file: chart.png](${imageUrl})`,
            `[Attached file: demo.mp4](${videoUrl})`,
            `[Attached file: briefing.mp3](${audioUrl})`,
            `[Attached file: notes.md](${markdownUrl})`,
          ].join("\n"),
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Review the launch assets")).toBeInTheDocument();
      expect(screen.getByLabelText("Preview chart.png")).toBeInTheDocument();
      expect(screen.getByLabelText("Preview demo.mp4")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open audio preview for briefing.mp3"),
      ).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open markdown preview for notes.md"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Copy message"));

    await waitFor(() => {
      expect(clipboard.writes).toHaveLength(1);
      expect(clipboard.writes[0]).toHaveLength(1);
    });
  });

  it("shows an empty artifact inbox from the chat header", async () => {
    mockChatLifecycle(context, {
      threadId: HISTORY_THREAD_ID,
      threadTitle: "Artifact inventory",
      chatMessages: [
        {
          id: "msg-empty-artifacts",
          role: "assistant",
          content: "No files were produced for this request.",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: [] });
    });

    detachedSetupPage({ context, path: `/chats/${HISTORY_THREAD_ID}` });

    click(await screen.findByLabelText("Open artifacts"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-inbox")).toBeInTheDocument();
      expect(
        screen.getByText("No uploaded files in this chat yet."),
      ).toBeInTheDocument();
    });
  });

  it("opens GitHub PR tracking from the dock", async () => {
    setupGithubPrTrackingPage();
    await openGithubPrTracking();

    await waitFor(() => {
      expect(screen.getByText("vm0-ai/vm0 #123")).toBeInTheDocument();
      expect(screen.getByText("Fix flaky platform tests")).toBeInTheDocument();
      expect(screen.getByText("Conflicts")).toBeInTheDocument();
      expect(screen.getByText("unit tests")).toBeInTheDocument();
      expect(screen.getByText("deploy preview")).toBeInTheDocument();
      expect(
        screen.getByText("Stabilize deploy preview checks"),
      ).toBeInTheDocument();
      expect(screen.getAllByText("Pending").length).toBeGreaterThan(0);
      expect(screen.getByText("security review")).toBeInTheDocument();
      expect(screen.getByText("Draft data cleanup")).toBeInTheDocument();
      expect(screen.getByText("Draft")).toBeInTheDocument();
      expect(screen.getByText("Ready coverage update")).toBeInTheDocument();
      expect(screen.getByText("Ready to merge")).toBeInTheDocument();
      expect(
        screen.getByText("External checks unavailable"),
      ).toBeInTheDocument();
      expect(screen.getByText("Unknown")).toBeInTheDocument();
      expect(screen.getAllByText("No GitHub Actions checks.")).toHaveLength(2);
    });

    click(screen.getByLabelText("Close GitHub PR tracking"));

    await waitFor(() => {
      expect(
        screen.queryByLabelText("GitHub PR tracking"),
      ).not.toBeInTheDocument();
    });
  });

  it("shows an empty GitHub PR tracking state", async () => {
    mockGithubPrTrackingThread();
    context.mocks.api(chatThreadGithubPrsContract.list, ({ respond }) => {
      return respond(200, { prs: [] });
    });
    detachedSetupPage({
      context,
      path: `/chats/${GITHUB_PR_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    await openGithubPrTracking();

    await waitFor(() => {
      expect(
        screen.getByText("No GitHub PRs found in this chat."),
      ).toBeInTheDocument();
    });
  });

  it("shows GitHub PR tracking load errors and toggles the dock from the header", async () => {
    mockGithubPrTrackingThread();
    context.mocks.api(chatThreadGithubPrsContract.list, ({ respond }) => {
      return respond(502, {
        error: {
          message: "GitHub status unavailable",
          code: "GITHUB_STATUS_UNAVAILABLE",
        },
      });
    });
    detachedSetupPage({
      context,
      path: `/chats/${GITHUB_PR_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    await openGithubPrTracking();

    await waitFor(() => {
      expect(
        screen.getByText("Failed to load GitHub PR status."),
      ).toBeInTheDocument();
    });
    expect(screen.getByLabelText("Open GitHub PR tracking")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    click(screen.getByLabelText("Open GitHub PR tracking"));

    await waitFor(() => {
      expect(
        screen.queryByLabelText("GitHub PR tracking"),
      ).not.toBeInTheDocument();
      expect(screen.getByLabelText("Open GitHub PR tracking")).toHaveAttribute(
        "aria-pressed",
        "false",
      );
    });
  });

  it("queues a GitHub PR label command from the tracking dock", async () => {
    setupGithubPrTrackingPage();
    await openGithubPrTracking();

    click(await screen.findByLabelText("Add label to PR 123"));
    click(await screen.findByText("needs-review"));

    await waitFor(() => {
      expect(
        screen.getByText('add label "needs-review" to pr 123'),
      ).toBeInTheDocument();
    });
  });

  it("queues a GitHub PR conflict fix command from the tracking dock", async () => {
    setupGithubPrTrackingPage();
    await openGithubPrTracking();

    click(await screen.findByText("Fix conflict"));

    await waitFor(() => {
      expect(
        screen.getByText("fix pr 123 conflict & push"),
      ).toBeInTheDocument();
    });
  });

  it("turns selected assistant text into an inline feedback follow-up", async () => {
    const user = userEvent.setup();
    const assistantReply = "The rollout dates are unclear in this summary.";
    context.mocks.browser.clipboardWriteText();

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatInlineFeedback]: true },
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement);

    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });

    await user.click(buttonByText("Copy"));

    await waitFor(() => {
      expect(screen.getByText("Copied")).toBeInTheDocument();
    });

    selectTextForInlineFeedback(assistantReplyElement);
    await user.click(buttonByText("Provide feedback"));

    const feedbackComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    await fill(feedbackComment, "Mention the dates before the risk summary.");
    expect(feedbackComment).toHaveValue(
      "Mention the dates before the risk summary.",
    );

    await user.click(buttonByText("Send 1 comment"));

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    expect(
      screen.queryByPlaceholderText("What should change about this?"),
    ).not.toBeInTheDocument();
  });

  it("keeps committed inline feedback while drafting another selected comment", async () => {
    const user = userEvent.setup();
    const assistantReply = "The launch summary needs clearer risk ownership.";

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-summary-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-summary",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-summary-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-summary",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatInlineFeedback]: true },
    });

    const assistantReplyElement = await screen.findByText(assistantReply);
    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));

    const firstComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    await fill(firstComment, "Assign each risk to an owner.");

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));

    await user.click(buttonByText("1 comment"));

    expect(
      screen.getByText("Assign each risk to an owner."),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "Select more text and click Provide feedback to add another comment",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByPlaceholderText("What should change about this?"),
    ).toHaveValue("");

    await user.click(screen.getByLabelText("Close"));

    await waitFor(() => {
      expect(
        screen.queryByText("Feedback on this reply"),
      ).not.toBeInTheDocument();
    });
  });

  it("edits and sends multiple inline feedback comments", async () => {
    const user = userEvent.setup();
    const assistantReply = "The launch summary needs clearer risk ownership.";
    const sentPrompts: string[] = [];

    mockChatLifecycle(context, {
      threadId: FEEDBACK_THREAD_ID,
      threadTitle: "Feedback review",
      chatMessages: [
        {
          id: "msg-feedback-edit-user",
          role: "user",
          content: "Review this launch summary",
          runId: "run-feedback-edit",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-feedback-edit-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-feedback-edit",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
      onRunCreate: (body) => {
        if (body.prompt !== undefined) {
          sentPrompts.push(body.prompt);
        }
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FEEDBACK_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatInlineFeedback]: true },
    });

    const assistantReplyElement = await screen.findByText(assistantReply);

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));

    await fill(
      await screen.findByPlaceholderText("What should change about this?"),
      "Assign each risk to an owner.",
    );

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));

    await fill(
      await screen.findByPlaceholderText("What should change about this?"),
      "Mention launch dates before the risk summary.",
    );

    selectTextForInlineFeedback(assistantReplyElement);
    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });
    await user.click(buttonByText("Provide feedback"));

    click(buttonByText("2 comments"));
    const firstCommentCard = screen
      .getByText("Assign each risk to an owner.")
      .closest("button");
    if (!firstCommentCard) {
      throw new Error("Feedback comment card not found");
    }
    click(firstCommentCard);

    const editingComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    expect(editingComment).toHaveValue("Assign each risk to an owner.");
    await fill(editingComment, "Assign named owners to each launch risk.");

    await user.click(buttonByText("Send 2 comments"));

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    expect(sentPrompts).toHaveLength(1);
    expect(sentPrompts[0]).toContain("Feedback on 2 parts of your reply:");
    expect(sentPrompts[0]).toContain(
      "> The launch summary needs clearer risk ownership.",
    );
    expect(sentPrompts[0]).toContain(
      "Assign named owners to each launch risk.",
    );
    expect(sentPrompts[0]).toContain(
      "Mention launch dates before the risk summary.",
    );
  });

  it("sends a recommended follow-up from the latest assistant reply", async () => {
    const assistantReply = "I can turn this into a launch package.";
    const followupPrompt = "Create a presentation outline";

    mockChatLifecycle(context, {
      threadId: FOLLOWUP_THREAD_ID,
      threadTitle: "Launch package",
      chatMessages: [
        {
          id: "msg-followup-user",
          role: "user",
          content: "Package this launch plan",
          runId: "run-followup",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-followup-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-followup",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-followup-completed",
          role: "assistant",
          content: null,
          runId: "run-followup",
          runLifecycleEvent: "completed",
          recommendedFollowups: [
            {
              prompt: followupPrompt,
              kind: "generate",
              generationType: "presentation",
            },
            {
              prompt: "Generate hero image",
              kind: "generate",
              generationType: "image",
            },
            {
              prompt: "Generate launch video",
              kind: "generate",
              generationType: "video",
            },
            {
              prompt: "Generate launch website",
              kind: "generate",
              generationType: "website",
            },
            {
              prompt: "Generate launch artifact",
              kind: "generate",
            },
            {
              prompt: "Draft launch copy",
              kind: "talk",
            },
          ],
          createdAt: "2026-06-09T10:01:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FOLLOWUP_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatRecommendedFollowups]: true },
    });

    await waitFor(() => {
      expect(screen.getByText(assistantReply)).toBeInTheDocument();
      expect(screen.getByText("Keep going")).toBeInTheDocument();
      expect(buttonByText(followupPrompt)).toBeInTheDocument();
      expect(buttonByText("Generate hero image")).toBeInTheDocument();
      expect(buttonByText("Generate launch video")).toBeInTheDocument();
      expect(buttonByText("Generate launch website")).toBeInTheDocument();
      expect(buttonByText("Generate launch artifact")).toBeInTheDocument();
      expect(buttonByText("Draft launch copy")).toBeInTheDocument();
    });

    click(buttonByText(followupPrompt));

    await waitFor(() => {
      expect(queryButtonByText(followupPrompt)).not.toBeInTheDocument();
      expect(screen.getByText(followupPrompt)).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
  });

  it("shows online computers in the chat composer", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-selection";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: "host-online",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: { accessibility: true, screenRecording: true },
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
          {
            id: "host-online-2",
            displayName: "Office Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: { accessibility: true, screenRecording: true },
            status: "online",
            lastSeenAt: "2026-06-10T12:01:00Z",
            createdAt: "2026-06-10T11:01:00Z",
          },
          {
            id: "host-offline",
            displayName: "Offline Desktop",
            appVersion: "1.0.0",
            osVersion: "Windows 11",
            supportedCapabilities: ["app.open"],
            permissions: { accessibility: true, screenRecording: true },
            status: "offline",
            lastSeenAt: "2026-06-09T12:00:00Z",
            createdAt: "2026-06-09T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ComputerUse]: true },
    });

    await user.click(await screen.findByLabelText("Computer Use"));

    await waitFor(() => {
      expect(screen.getByText("Studio Mac")).toBeInTheDocument();
      expect(screen.getByText("Office Mac")).toBeInTheDocument();
      expect(screen.queryByText("Offline Desktop")).not.toBeInTheDocument();
      expect(screen.getByText("Connect my computer")).toBeInTheDocument();
      expect(screen.getByRole("radio", { name: "Studio Mac" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
      expect(screen.getByRole("radio", { name: "Office Mac" })).toHaveAttribute(
        "aria-checked",
        "false",
      );
    });
  });

  it("does not auto-select the only online Computer Use host", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-manual-selection";
    let sentComputerUseHostId: string | null | undefined;
    mockChatLifecycle(context, {
      threadId,
      onRunCreate: (body) => {
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: "host-online",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: { accessibility: true, screenRecording: true },
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ComputerUse]: true },
    });

    await user.click(await screen.findByLabelText("Computer Use"));
    expect(screen.getByRole("radio", { name: "Studio Mac" })).toHaveAttribute(
      "aria-checked",
      "false",
    );

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Open the app on my computer");

    await waitFor(() => {
      expect(
        screen.getByText("Open the app on my computer"),
      ).toBeInTheDocument();
      expect(sentComputerUseHostId).toBeNull();
    });
  });

  it("refreshes online computers when the chat composer popover opens", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-refresh";
    let hostOnline = true;
    let requestCount = 0;
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      requestCount += 1;
      return respond(200, {
        hosts: [
          {
            id: "host-refresh",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: { accessibility: true, screenRecording: true },
            status: hostOnline ? "online" : "offline",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ComputerUse]: true },
    });

    await user.click(await screen.findByLabelText("Computer Use"));

    await waitFor(() => {
      expect(screen.getByText("Studio Mac")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Computer Use"));
    await waitFor(() => {
      expect(screen.queryByText("Connect my computer")).not.toBeInTheDocument();
    });

    const requestCountAfterFirstOpen = requestCount;
    hostOnline = false;

    await user.click(screen.getByLabelText("Computer Use"));

    await waitFor(() => {
      expect(requestCount).toBeGreaterThan(requestCountAfterFirstOpen);
      expect(screen.queryByText("Studio Mac")).not.toBeInTheDocument();
      expect(screen.getByText("No online computers")).toBeInTheDocument();
    });
  });

  it("sends the selected Computer Use host with the chat request", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-send";
    let sentComputerUseHostId: string | null | undefined;
    mockChatLifecycle(context, {
      threadId,
      onRunCreate: (body) => {
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: "host-online",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: { accessibility: true, screenRecording: true },
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ComputerUse]: true },
    });

    await user.click(await screen.findByLabelText("Computer Use"));
    await user.click(await screen.findByRole("radio", { name: "Studio Mac" }));

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Open the app on my computer");

    await waitFor(() => {
      expect(
        screen.getByText("Open the app on my computer"),
      ).toBeInTheDocument();
      expect(sentComputerUseHostId).toBe("host-online");
    });
  });

  it("shows and clears a saved Computer Use host selection", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-saved-selection";
    const hostId = "11111111-1111-4111-8111-111111111111";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Computer Use",
      computerUseHostId: hostId,
    });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: { accessibility: true, screenRecording: true },
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ComputerUse]: true },
    });

    await user.click(await screen.findByLabelText("Computer Use"));

    const selectedComputer = await screen.findByRole("radio", {
      name: "Studio Mac",
    });
    expect(selectedComputer).toHaveAttribute("aria-checked", "true");
    await user.click(selectedComputer);

    await waitFor(() => {
      expect(selectedComputer).toHaveAttribute("aria-checked", "false");
    });
  });

  it("shows a computer use empty state when host listing is unavailable", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-forbidden";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(403, {
        error: {
          code: "FORBIDDEN",
          message: "Computer Use is unavailable",
        },
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.ComputerUse]: true },
    });

    await user.click(await screen.findByLabelText("Computer Use"));

    await waitFor(() => {
      expect(screen.getByText("No online computers")).toBeInTheDocument();
      expect(screen.getByText("Connect my computer")).toBeInTheDocument();
    });
  });

  it("transcribes voice input into the composer", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "voice-input-thread";
    context.mocks.browser.voiceInput();
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
      return new Response(JSON.stringify({ text: "Summarize the standup" }), {
        headers: { "Content-Type": "application/json" },
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });

    await user.click(await screen.findByLabelText("Voice input"));

    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(textarea).toHaveValue("Summarize the standup");
    });
  });

  it("opens billing recovery when voice input quota is depleted", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "voice-input-quota-thread";
    context.mocks.browser.voiceInput();
    mockChatLifecycle(context, { threadId });
    context.mocks.http.post("*/api/zero/voice-io/stt", () => {
      return new Response(
        JSON.stringify({
          error: {
            code: "AUDIO_INPUT_QUOTA_EXCEEDED",
            message: "Audio input quota exceeded",
          },
        }),
        { status: 402, headers: { "Content-Type": "application/json" } },
      );
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByPlaceholderText(PLACEHOLDER)).toBeInTheDocument();
    });

    await user.click(await screen.findByLabelText("Voice input"));
    await waitFor(() => {
      expect(screen.getByLabelText("Stop recording")).toBeInTheDocument();
    });
    await user.click(screen.getByLabelText("Stop recording"));

    await waitFor(() => {
      expect(screen.getByRole("dialog")).toBeInTheDocument();
      expect(
        screen.getByRole("heading", { name: "Compare plans" }),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Upgrade or downgrade anytime."),
      ).toBeInTheDocument();
    });
  });

  it("sends readable assistant content to audio output", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "audio-output-thread";
    const runId = "a0000000-0000-4000-a000-000000000401";
    const assistantReply = [
      "## Launch notes",
      "- **Ship** the preview",
      "- [Open dashboard](https://example.com)",
      "",
      "```ts",
      "const hidden = true;",
      "```",
    ].join("\n");
    let capturedTtsBody: unknown = null;

    context.mocks.browser.audioContext();
    context.mocks.http.post("*/api/zero/voice-io/tts", async ({ request }) => {
      capturedTtsBody = await request.json();
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(new Uint8Array([0, 0, 1, 0, 2, 0]));
            controller.close();
          },
        }),
        { headers: { "Content-Type": "audio/pcm" } },
      );
    });
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Audio output",
      chatMessages: [
        {
          id: "msg-audio-output-user",
          role: "user",
          content: "Read the launch notes",
          runId,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-audio-output-assistant",
          role: "assistant",
          content: assistantReply,
          runId,
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: { [FeatureSwitchKey.AudioOutput]: true },
    });

    await waitFor(() => {
      expect(screen.getByText("Launch notes")).toBeInTheDocument();
      expect(screen.getByLabelText("Read aloud")).toBeInTheDocument();
    });

    await user.click(screen.getByLabelText("Read aloud"));

    await waitFor(() => {
      expect(capturedTtsBody).toStrictEqual({
        text: "Launch notes\nShip the preview\nOpen dashboard",
      });
      expect(screen.getByLabelText("Read aloud")).toBeInTheDocument();
    });
  });

  it("shows billing recovery guidance when credits are depleted", async () => {
    const threadId = "failed-guidance-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.api(
      zeroBillingCheckoutContract.create,
      ({ body, respond }) => {
        return respond(200, {
          url: `https://checkout.stripe.com/recover?tier=${body.tier}`,
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Upgrade to Pro to run Zero"),
      ).toBeInTheDocument();
      expect(buttonByText("Upgrade to Pro")).toBeInTheDocument();
    });

    click(buttonByText("Upgrade to Pro"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/recover?tier=pro",
      );
    });
  });

  it("shows admin-only billing guidance when a member runs out of credits", async () => {
    const threadId = "failed-guidance-member-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "member",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Upgrade to Pro to run Zero"),
      ).toBeInTheDocument();
      expect(
        screen.getByText(
          "Ask a workspace admin to upgrade to Pro so you can keep chatting with Zero.",
        ),
      ).toBeInTheDocument();
      expect(queryButtonByText("Upgrade to Pro")).toBeNull();
    });
  });

  it("shows that chat can continue when credits become available", async () => {
    const threadId = "failed-guidance-restored-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        credits: 1500,
        onboardingPaymentPending: false,
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: true,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [],
        creditGrants: [],
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Credits available")).toBeInTheDocument();
      expect(
        screen.getByText(
          "Your credits have been added. You can continue chatting with Zero.",
        ),
      ).toBeInTheDocument();
      expect(queryButtonByText("Upgrade to Pro")).toBeNull();
    });
  });

  it("shows paid credit top-ups when a paid workspace runs out of credits", async () => {
    const threadId = "failed-guidance-paid-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "pro",
        credits: 0,
        onboardingPaymentPending: false,
        subscriptionStatus: "active",
        currentPeriodEnd: "2026-04-01T00:00:00Z",
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: true,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [],
        creditGrants: [],
      });
    });
    context.mocks.api(
      zeroBillingCreditCheckoutContract.create,
      ({ body, respond }) => {
        return respond(200, {
          url: `https://checkout.stripe.com/credits?credits=${body.credits}`,
        });
      },
    );
    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("You're out of credits")).toBeInTheDocument();
      expect(
        screen.getByText("Add credits to keep chatting with Zero."),
      ).toBeInTheDocument();
      expect(buttonByText("$100")).toBeInTheDocument();
      expect(buttonByText("$200")).toBeInTheDocument();
      expect(buttonByText("$300")).toBeInTheDocument();
    });

    click(buttonByText("Custom"));
    await fill(screen.getByLabelText("Custom dollar amount"), "0");
    click(buttonByText("Buy"));

    await waitFor(() => {
      expect(
        screen.getByText("Enter between $1 and $10,000"),
      ).toBeInTheDocument();
    });

    await fill(screen.getByLabelText("Custom dollar amount"), "25");
    click(buttonByText("Buy"));

    await waitFor(() => {
      expect(window.location.href).toBe(
        "https://checkout.stripe.com/credits?credits=25000",
      );
    });
  });

  it("shows model-provider setup guidance from failed assistant messages", async () => {
    const threadId = "failed-guidance-provider";
    mockFailedAssistantThread({
      threadId,
      error: "No model provider configured",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText(/No model provider configured yet/u),
      ).toBeInTheDocument();
      expect(
        buttonByText("Set one up in Workspace Settings"),
      ).toBeInTheDocument();
    });
  });

  it("shows restart guidance for incompatible provider sessions", async () => {
    const threadId = "failed-guidance-incompatible";
    mockFailedAssistantThread({
      threadId,
      error: "Cannot continue session with the selected provider",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText(/started with a different model provider/u),
      ).toBeInTheDocument();
      expect(screen.getByText("Start a new session")).toBeInTheDocument();
    });
  });

  it("shows restart guidance for deleted provider sessions", async () => {
    const threadId = "failed-guidance-deleted";
    mockFailedAssistantThread({
      threadId,
      error: "Model provider unavailable",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText(
          /model provider used by this thread has been deleted/u,
        ),
      ).toBeInTheDocument();
      expect(screen.getByText("Start a new chat thread")).toBeInTheDocument();
    });
  });

  it("renders generic assistant failures as markdown", async () => {
    const threadId = "failed-guidance-generic";
    mockFailedAssistantThread({
      threadId,
      error: "Unexpected **tool** failure",
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(/Unexpected.*failure/u)).toBeInTheDocument();
      expect(screen.getByText("tool")).toBeInTheDocument();
    });
  });

  it("switches sessions without stale running or completed messages", async () => {
    context.mocks.api(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        pinned: [],
        threads: [
          {
            id: "thread-running",
            title: "Running thread",
            agent: { id: AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-10T00:00:00Z",
            updatedAt: "2026-03-10T00:00:00Z",
            isRead: true,
            running: true,
          },
          {
            id: "thread-completed",
            title: "Completed thread",
            agent: { id: AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-10T00:01:00Z",
            updatedAt: "2026-03-10T00:01:00Z",
            isRead: true,
            running: false,
          },
        ],
        hasMore: false,
        nextCursor: null,
        totalCount: 2,
      });
    });
    context.mocks.api(
      chatThreadMessagesContract.list,
      ({ params, query, respond }) => {
        if (query.sinceId) {
          return respond(200, { messages: [] });
        }
        if (params.threadId === "thread-running") {
          return respond(200, {
            messages: [
              {
                id: "msg-running-user",
                role: "user",
                content: "Active task prompt",
                runId: "run-active",
                createdAt: "2026-03-10T00:00:00Z",
              },
              {
                id: "msg-running-assistant",
                role: "assistant",
                content: null,
                runId: "run-active",
                createdAt: "2026-03-10T00:00:01Z",
              },
            ],
          });
        }
        return respond(200, {
          messages: [
            {
              id: "msg-completed-user",
              role: "user",
              content: "Done task",
              createdAt: "2026-03-10T00:00:00Z",
            },
            {
              id: "msg-completed-assistant",
              role: "assistant",
              content: "All done!",
              createdAt: "2026-03-10T00:00:01Z",
            },
          ],
        });
      },
    );
    context.mocks.api(chatThreadByIdContract.get, ({ params, respond }) => {
      const running = params.id === "thread-running";
      return respond(200, {
        id: params.id,
        title: null,
        agentId: AGENT_ID,
        activeRunIds: running ? ["run-active"] : [],
        draftContent: null,
        draftAttachments: null,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(logsByIdContract.getById, ({ respond }) => {
      return respond(200, {
        id: "run-active",
        sessionId: "session-1",
        agentId: "zero",
        displayName: null,
        framework: "claude-code",
        modelProvider: null,
        selectedModel: null,
        triggerSource: "web",
        triggerAgentName: null,
        scheduleId: null,
        status: "running",
        prompt: "Active task prompt",
        appendSystemPrompt: null,
        error: null,
        createdAt: "2026-03-10T00:00:00Z",
        startedAt: "2026-03-10T00:00:01Z",
        completedAt: null,
        artifact: { name: null, version: null },
      });
    });
    context.mocks.api(
      zeroRunAgentEventsContract.getAgentEvents,
      ({ respond }) => {
        return respond(200, {
          events: [],
          hasMore: false,
          framework: "claude-code",
        });
      },
    );
    context.mocks.api(zeroRunsByIdContract.getById, ({ respond }) => {
      return respond(200, {
        runId: "run-active",
        agentComposeVersionId: null,
        status: "running",
        prompt: "Active task prompt",
        appendSystemPrompt: null,
        result: { agentSessionId: "session-1", output: "" },
        createdAt: "2026-03-10T00:00:00Z",
      });
    });
    context.mocks.api(zeroQueuePositionContract.getPosition, ({ respond }) => {
      return respond(200, { position: 0, total: 0 });
    });

    detachedSetupPage({ context, path: "/chats/thread-running" });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    const completedThreadLink = await waitFor(() => {
      return queryAllByRoleFast("link").find((element) => {
        return element.getAttribute("href") === "/chats/thread-completed";
      });
    });
    if (!completedThreadLink) {
      throw new Error("Completed thread link not found");
    }
    click(completedThreadLink);

    await waitFor(() => {
      expect(screen.getByText("All done!")).toBeInTheDocument();
      expect(screen.queryByText("Active task prompt")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
    });
  });
});
