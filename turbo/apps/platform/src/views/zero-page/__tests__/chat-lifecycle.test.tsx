import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadGithubPrsContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  chatThreadRenameContract,
  chatThreadsContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import {
  ILLUSTRATION_TEMPLATE_ITEMS,
  PRESENTATION_TEMPLATE_PICKER_ITEMS,
  VIDEO_TEMPLATE_ITEMS,
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
import { zeroGoalsContract } from "@vm0/api-contracts/contracts/zero-goals";
import {
  zeroWorkflowsCollectionContract,
  zeroWorkflowTriggersContract,
  type ZeroWorkflowTriggerUpdateRequest,
} from "@vm0/api-contracts/contracts/zero-workflows";
import {
  createMockAutomationView,
  createMockWorkflowTrigger,
  setMockWorkflowTriggers,
} from "../../../mocks/handlers/automations-store.ts";
import { testContext } from "../../../signals/__tests__/test-helpers.ts";
import {
  click,
  detachedSetupPage,
  fill,
  queryAllByRoleFast,
} from "../../../__tests__/page-helper.ts";
import {
  expectQueuedMessages,
  mockChatLifecycle,
  mockSubagentThread,
  PLACEHOLDER,
  sendQueuedMessage,
  sendMessageInUI,
  splitChatThreadListResponse,
} from "./chat-test-helpers.ts";
import { CREATE_WORKFLOW_WITH_CHAT_PROMPT } from "../workflow-chat-prompts.ts";

const context = testContext();

const AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const AUTOMATION_THREAD_ID = "b0000000-0000-4000-a000-000000000701";
const GITHUB_PR_THREAD_ID = "b0000000-0000-4000-a000-000000000702";
const FOLLOWUP_THREAD_ID = "b0000000-0000-4000-a000-000000000704";
const HISTORY_THREAD_ID = "b0000000-0000-4000-a000-000000000705";
const AGENT_CHAT_PATH = `/agents/${AGENT_ID}/chat`;

function computerUsePermissions() {
  return {
    accessibility: true,
    screenRecording: true,
    automation: {
      chrome: { status: "unknown" as const, updatedAt: null, reason: null },
      safari: { status: "unknown" as const, updatedAt: null, reason: null },
    },
  };
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

async function readSingleRichClipboardWrite(clipboard: {
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

async function readClipboardItemText(
  item: ClipboardItem,
  type: string,
): Promise<string> {
  const blob = await item.getType(type);
  return await blob.text();
}

function parseChatClipboardPayload(html: string): {
  text: string;
  attachments: {
    id: string | null;
    url: string;
    filename: string;
    contentType: string;
    size: number;
  }[];
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
  };
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

function makeRunGroupMessages(params: {
  readonly label: string;
  readonly count: number;
  readonly runGroupId: string;
  readonly startMinute: number;
}): PagedChatMessage[] {
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

function expectTextBefore(
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

function makeMessage(id: string, text: string): PagedChatMessage {
  return {
    id,
    role: "user",
    content: text,
    createdAt: "2026-05-01T00:00:00Z",
  };
}

function mockKeyboardNavigationThreads({
  currentTitle = "Current keyboard thread",
  currentDetailTitle = currentTitle,
}: {
  currentTitle?: string;
  currentDetailTitle?: string | null;
} = {}): void {
  const threadFixtures = [
    {
      id: "keyboard-prev-thread",
      title: "Previous keyboard thread",
      detailTitle: "Previous keyboard thread",
      message: "Previous thread launch note",
    },
    {
      id: "keyboard-current-thread",
      title: currentTitle,
      detailTitle: currentDetailTitle,
      message: "Current thread launch note",
    },
    {
      id: "keyboard-next-thread",
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
      title: thread.detailTitle,
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
  context.mocks.api(chatThreadRenameContract.rename, ({ respond }) => {
    return respond(204);
  });
}

function mockAutomationThread(): void {
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
  context.mocks.data.automations([
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000701",
      agentId: AGENT_ID,
      chatThreadId: AUTOMATION_THREAD_ID,
      name: "launch-review",
      description: "Launch review",
      prompt: "Review launch risks",
      cronExpression: "30 15 * * 1-5",
      triggerType: "cron",
      nextRunAt: "2026-06-10T15:30:00.000Z",
    }),
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000702",
      agentId: AGENT_ID,
      chatThreadId: AUTOMATION_THREAD_ID,
      name: "paused-launch-audit",
      description: "Paused launch audit",
      prompt: "Audit launch readiness",
      cronExpression: "0 12 * * 1",
      triggerType: "cron",
      enabled: false,
      nextRunAt: null,
    }),
    createMockAutomationView({
      id: "f0000001-0000-4000-a000-000000000703",
      agentId: AGENT_ID,
      chatThreadId: AUTOMATION_THREAD_ID,
      name: "manual-launch-reminder",
      description: "Manual launch reminder",
      prompt: "Remind the team about launch blockers",
      cronExpression: "0 18 * * 5",
      triggerType: "cron",
      nextRunAt: null,
    }),
  ]);
}

function mockWorkflowTriggerUpdate(
  onUpdate: (triggerId: string, body: ZeroWorkflowTriggerUpdateRequest) => void,
): void {
  context.mocks.api(
    zeroWorkflowTriggersContract.update,
    ({ body, params, respond }) => {
      onUpdate(params.id, body);
      if ("schedule" in body) {
        return respond(
          200,
          createMockWorkflowTrigger({
            id: params.id,
            chatThreadId: AUTOMATION_THREAD_ID,
            kind: "schedule",
            schedule: body.schedule,
          }),
        );
      }
      return respond(
        200,
        createMockWorkflowTrigger({
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
      lastReadAt: "2026-06-09T10:00:00Z",
      lastMessageAt: "2026-06-09T10:00:00Z",
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
    return respond(200, { lastReadMessageId: null, unreads: [] });
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
      reconnectReason: null,
      tokenExpiresAt: null,
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-01T00:00:00Z",
    },
  ]);
  context.mocks.data.githubIntegration(
    context.mocks.data.defaultGithubIntegration(),
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

function buttonByText(text: string, container?: ParentNode): HTMLElement {
  const button = queryAllByRoleFast("button", container).find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!button) {
    throw new Error(`${text} button not found`);
  }
  return button;
}

async function findWorkflowComposerEditor(): Promise<HTMLElement> {
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

function mockWorkflowComposerWorkflows(): void {
  context.mocks.api(zeroWorkflowsCollectionContract.list, ({ respond }) => {
    return respond(200, []);
  });
}

function selectOptionByLabel(
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

async function openAutomationSidebarWithWorkflowTrigger(
  trigger: ReturnType<typeof createMockWorkflowTrigger>,
): Promise<HTMLElement> {
  mockAutomationThread();
  setMockWorkflowTriggers([trigger]);
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

function buttonByLabel(label: string): HTMLElement {
  const button = queryAllByRoleFast("button").find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!button) {
    throw new Error(`${label} button not found`);
  }
  return button;
}

function menuItemByLabel(label: string, container: HTMLElement): HTMLElement {
  const item = queryAllByRoleFast("menuitem", container).find((candidate) => {
    return candidate.getAttribute("aria-label") === label;
  });
  if (!item) {
    throw new Error(`${label} menu item not found`);
  }
  return item;
}

function linkByText(text: string): HTMLElement {
  const link = queryAllByRoleFast("link").find((candidate) => {
    return candidate.textContent?.replace(/\s+/g, " ").trim() === text;
  });
  if (!link) {
    throw new Error(`${text} link not found`);
  }
  return link;
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

function chatComposerTextarea(): HTMLTextAreaElement {
  const element = document.querySelector("[data-chat-composer] textarea");
  if (!(element instanceof HTMLTextAreaElement)) {
    throw new Error("Chat composer textarea not found");
  }
  return element;
}

function activeElementIsInside(element: HTMLElement): boolean {
  return (
    document.activeElement === element ||
    (document.activeElement instanceof Node &&
      element.contains(document.activeElement))
  );
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

  it("renders user html-like text literally", async () => {
    const threadId = "thread-user-html-like-text";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          role: "user",
          content: "<span> 123 </span>",
          createdAt: "2026-03-10T00:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const userBubble = await waitFor(() => {
      const bubble = document.querySelector(".zero-chat-bubble-user");
      expect(bubble).toBeInstanceOf(HTMLElement);
      expect(
        within(bubble as HTMLElement).getByText("<span> 123 </span>"),
      ).toBeInTheDocument();
      return bubble as HTMLElement;
    });

    expect(userBubble.querySelector("span")).toBeNull();
  });

  it("ignores usage-only pages for rendering and thinking state", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-only",
      chatMessages: [
        {
          id: "msg-usage-only",
          role: "assistant",
          content: null,
          runId: "run-usage-only",
          usage: {
            version: 1,
            totalCredits: 0,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model",
                credits: 0,
                providers: [{ provider: "vm0", credits: 0 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-only",
    });

    await waitFor(() => {
      expect(document.querySelector("[data-role='assistant']")).toBeNull();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("shows thinking for an assistant run even without active run ids", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-message-list-thinking",
      activeRunIds: [],
      chatMessages: [
        {
          id: "msg-message-list-assistant",
          role: "assistant",
          content: "I am working on this.",
          runId: "run-message-list-thinking",
          runEventId: "event-message-list-assistant-text",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-message-list-thinking",
    });

    await waitFor(() => {
      expect(screen.getByText("I am working on this.")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });
  });

  it("clears thinking when the same run completes even with stale active run ids", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-message-list-completed",
      activeRunIds: ["run-message-list-completed"],
      chatMessages: [
        {
          id: "msg-message-list-completed-assistant",
          role: "assistant",
          content: "The answer is ready.",
          runId: "run-message-list-completed",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-message-list-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-message-list-completed",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-message-list-completed",
    });

    await waitFor(() => {
      expect(screen.getByText("The answer is ready.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("keeps thinking when a different run completes while another run is open", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-stale-lifecycle-thinking",
      activeRunIds: [],
      chatMessages: [
        {
          id: "msg-stale-usage-r1",
          role: "assistant",
          content: null,
          runId: "run-r1",
          usage: {
            version: 1,
            totalCredits: 5,
            settledAt: "2026-06-09T10:00:00Z",
            breakdown: [
              {
                kind: "model/kimi-k2.5/tokens.input",
                credits: 5,
                providers: [{ provider: "moonshot", credits: 5 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-stale-user-r2",
          role: "user",
          content: "Continue the plan",
          runId: "run-r2",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-stale-start-r2",
          role: "assistant",
          content: null,
          runId: "run-r2",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-stale-assistant-r2",
          role: "assistant",
          content: "The next step is ready.",
          runId: "run-r2",
          runEventId: "event-r2-assistant-text",
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-stale-completed-r3",
          role: "assistant",
          content: null,
          runId: "run-r3",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:04Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-stale-lifecycle-thinking",
    });

    await waitFor(() => {
      expect(screen.getByText("Continue the plan")).toBeInTheDocument();
      expect(screen.getByText("The next step is ready.")).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });
  });

  it("keeps interleaved run messages grouped by run turn", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-interleaved-run-turns",
      chatMessages: [
        {
          id: "msg-run-a-user",
          role: "user",
          content: "Start run A",
          runId: "run-a",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-run-a-first-assistant",
          role: "assistant",
          content: "A first update",
          runId: "run-a",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-run-b-user",
          role: "user",
          content: "Start run B",
          runId: "run-b",
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-run-a-final-assistant",
          role: "assistant",
          content: "A final update",
          runId: "run-a",
          createdAt: "2026-06-09T10:00:04Z",
        },
        {
          id: "msg-run-a-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-a",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:05Z",
        },
        {
          id: "msg-run-b-assistant",
          role: "assistant",
          content: "B answer",
          runId: "run-b",
          createdAt: "2026-06-09T10:00:06Z",
        },
        {
          id: "msg-run-b-completed-marker",
          role: "assistant",
          content: null,
          runId: "run-b",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:07Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-interleaved-run-turns",
    });

    await waitFor(() => {
      expect(screen.getByText("A final update")).toBeInTheDocument();
      expect(screen.getByText("Start run B")).toBeInTheDocument();
      expect(screen.getByText("B answer")).toBeInTheDocument();
    });

    expectTextBefore(document.body, "A final update", "Start run B");
    expectTextBefore(document.body, "Start run B", "B answer");
    expect(document.querySelectorAll('[data-role="assistant"]')).toHaveLength(
      2,
    );
  });

  it("shows thinking when the latest message is a user message", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-message-list-latest-user",
      activeRunIds: [],
      chatMessages: [
        {
          id: "msg-message-list-latest-user",
          role: "user",
          content: "Start the next run",
          runId: "run-message-list-latest-user",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-message-list-latest-user",
    });

    await waitFor(() => {
      expect(screen.getByText("Start the next run")).toBeInTheDocument();
      expect(
        document.querySelector("[data-thinking-indicator]"),
      ).not.toBeNull();
    });
  });

  it("clears thinking when a run is cancelled", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-message-list-cancelled",
      activeRunIds: ["run-message-list-cancelled"],
      chatMessages: [
        {
          id: "msg-message-list-cancelled-assistant",
          role: "assistant",
          content: "I started this run.",
          runId: "run-message-list-cancelled",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-message-list-cancelled-marker",
          role: "assistant",
          content: "Run cancelled",
          runId: "run-message-list-cancelled",
          error: "Run cancelled",
          runLifecycleEvent: "cancelled",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-message-list-cancelled",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Paused mid-thought — pick it back up whenever."),
      ).toBeInTheDocument();
      expect(screen.queryByLabelText("Stop")).not.toBeInTheDocument();
      expect(document.querySelector("[data-thinking-indicator]")).toBeNull();
    });
  });

  it("shows run credit usage with friendly popover details", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-chip",
      chatMessages: [
        {
          id: "msg-usage-chip-user",
          role: "user",
          content: "Summarize usage",
          runId: "run-usage-chip",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-usage-chip-assistant",
          role: "assistant",
          content: "Usage summary is ready.",
          runId: "run-usage-chip",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-usage-chip",
          role: "assistant",
          content: null,
          runId: "run-usage-chip",
          usage: {
            version: 1,
            totalCredits: 24_234,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model/kimi-k2.5/tokens.input",
                credits: 234,
                providers: [{ provider: "moonshot", credits: 234 }],
              },
              {
                kind: "model/kimi-k2.5/tokens.output",
                credits: 1000,
                providers: [{ provider: "moonshot", credits: 1000 }],
              },
              {
                kind: "image",
                credits: 23_000,
                providers: [{ provider: "gpt-image-2", credits: 23_000 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-chip",
    });

    const credit = await waitFor(() => {
      return buttonByLabel("Credit usage 24,234");
    });
    const actions = credit.closest('[data-testid="chat-message-actions"]');
    expect(actions).not.toBeNull();
    const copy = within(actions as HTMLElement).getByLabelText("Copy message");
    expect(
      copy.compareDocumentPosition(credit) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    click(credit);

    await waitFor(() => {
      expect(screen.getAllByText("Credit usage").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("24,234").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Kimi K2.5").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("1,234").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("GPT Image 2").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("23,000").length).toBeGreaterThanOrEqual(1);
      expect(
        screen.queryByText("model/kimi-k2.5/tokens.input"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText("moonshot")).not.toBeInTheDocument();
    });

    click(credit);

    await waitFor(() => {
      expect(screen.queryByText("Credit usage")).not.toBeInTheDocument();
    });

    click(credit);

    await waitFor(() => {
      expect(screen.getAllByText("Credit usage").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("Kimi K2.5").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("1,234").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("shows generation usage with model names only", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-generation-usage-model-names",
      chatMessages: [
        {
          id: "msg-generation-usage-user",
          role: "user",
          content: "Generate image and video usage",
          runId: "run-generation-usage",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-generation-usage-assistant",
          role: "assistant",
          content: "Generated media is ready.",
          runId: "run-generation-usage",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-generation-usage",
          role: "assistant",
          content: null,
          runId: "run-generation-usage",
          usage: {
            version: 1,
            totalCredits: 1976,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "image",
                credits: 96,
                providers: [{ provider: "fal-ai/nano-banana-2", credits: 96 }],
              },
              {
                kind: "video",
                credits: 1880,
                providers: [
                  {
                    provider: "dreamina-seedance-2-0-260128",
                    credits: 1880,
                  },
                ],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-generation-usage-model-names",
    });

    const credit = await screen.findByLabelText("Credit usage 1,976");
    click(credit);

    await waitFor(() => {
      expect(screen.getAllByText("Credit usage").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(
        screen.getAllByText("Nano Banana 2").length,
      ).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("96").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("Seedance 2.0").length).toBeGreaterThanOrEqual(
        1,
      );
      expect(screen.getAllByText("1,880").length).toBeGreaterThanOrEqual(1);
      expect(screen.queryByText(/fal\.? ?ai/iu)).not.toBeInTheDocument();
      expect(screen.queryByText(/dreamina/iu)).not.toBeInTheDocument();
    });
  });

  it("shows the latest immutable run usage settlement", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-chip-settlements",
      chatMessages: [
        {
          id: "msg-usage-settlement-user",
          role: "user",
          content: "Summarize usage settlements",
          runId: "run-usage-settlement",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-usage-settlement-assistant",
          role: "assistant",
          content: "Usage summary is ready.",
          runId: "run-usage-settlement",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-usage-settlement-first",
          role: "assistant",
          content: null,
          runId: "run-usage-settlement",
          usage: {
            version: 1,
            totalCredits: 12,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model/gpt-5.5/tokens.output",
                credits: 12,
                providers: [{ provider: "openai", credits: 12 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-usage-settlement-second",
          role: "assistant",
          content: null,
          runId: "run-usage-settlement",
          usage: {
            version: 1,
            totalCredits: 108,
            settledAt: "2026-06-09T10:00:05Z",
            breakdown: [
              {
                kind: "model/gpt-5.5/tokens.output",
                credits: 12,
                providers: [{ provider: "openai", credits: 12 }],
              },
              {
                kind: "image",
                credits: 96,
                providers: [{ provider: "nano-banana-2", credits: 96 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:05Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-chip-settlements",
    });

    await expect(
      screen.findByLabelText("Credit usage 108"),
    ).resolves.toBeInTheDocument();
    expect(screen.queryByLabelText("Credit usage 12")).not.toBeInTheDocument();
  });

  it("keeps connector usage visible when completed work is folded", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-chip-folded-connector",
      chatMessages: [
        {
          id: "msg-usage-folded-user",
          role: "user",
          content: "Use the connector",
          runId: "run-usage-folded-connector",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-usage-folded-work",
          role: "assistant",
          content: "Inspecting connector results.",
          runId: "run-usage-folded-connector",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-usage-folded-final",
          role: "assistant",
          content: "Connector usage is ready.",
          runId: "run-usage-folded-connector",
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-usage-folded-usage",
          role: "assistant",
          content: null,
          runId: "run-usage-folded-connector",
          usage: {
            version: 1,
            totalCredits: 108,
            settledAt: "2026-06-09T10:00:03Z",
            breakdown: [
              {
                kind: "connector",
                credits: 108,
                providers: [{ provider: "x", credits: 108 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-usage-folded-completed",
          role: "assistant",
          content: null,
          runId: "run-usage-folded-connector",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:04Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-chip-folded-connector",
    });

    await expect(
      screen.findByText("Connector usage is ready."),
    ).resolves.toBeInTheDocument();
    expect(
      screen.queryByText("Inspecting connector results."),
    ).not.toBeInTheDocument();

    const connectorCredit = await screen.findByLabelText("Credit usage 108");
    click(connectorCredit);

    await waitFor(() => {
      expect(screen.getAllByText("X").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("108").length).toBeGreaterThanOrEqual(1);
    });
  });

  it("keeps connector usage attached to consecutive assistant runs", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-usage-chip-consecutive-runs",
      chatMessages: [
        {
          id: "msg-usage-consecutive-user",
          role: "user",
          content: "Summarize two runs",
          runId: "run-usage-model",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-usage-consecutive-model-assistant",
          role: "assistant",
          content: "Model usage is ready.",
          runId: "run-usage-model",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-usage-consecutive-model",
          role: "assistant",
          content: null,
          runId: "run-usage-model",
          usage: {
            version: 1,
            totalCredits: 12,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "model/gpt-5.5/tokens.output",
                credits: 12,
                providers: [{ provider: "openai", credits: 12 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-usage-consecutive-model-completed",
          role: "assistant",
          content: null,
          runId: "run-usage-model",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:03Z",
        },
        {
          id: "msg-usage-consecutive-connector-assistant",
          role: "assistant",
          content: "Connector usage is ready.",
          runId: "run-usage-connector",
          createdAt: "2026-06-09T10:00:04Z",
        },
        {
          id: "msg-usage-consecutive-connector",
          role: "assistant",
          content: null,
          runId: "run-usage-connector",
          usage: {
            version: 1,
            totalCredits: 108,
            settledAt: "2026-06-09T10:00:05Z",
            breakdown: [
              {
                kind: "connector",
                credits: 108,
                providers: [{ provider: "x", credits: 108 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:05Z",
        },
        {
          id: "msg-usage-consecutive-connector-completed",
          role: "assistant",
          content: null,
          runId: "run-usage-connector",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:06Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-usage-chip-consecutive-runs",
    });

    await expect(
      screen.findByLabelText("Credit usage 12"),
    ).resolves.toBeInTheDocument();
    const connectorCredit = await screen.findByLabelText("Credit usage 108");

    click(connectorCredit);

    await waitFor(() => {
      expect(screen.getByText("Connector usage is ready.")).toBeInTheDocument();
      expect(screen.getAllByText("X").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("108").length).toBeGreaterThanOrEqual(1);
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

  it("keeps completed chat work folded while a later run is active", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-completed-before-active",
      activeRunIds: ["run-work-folding-active-later"],
      chatMessages: [
        {
          role: "user",
          content: "Summarize the earlier launch",
          runId: "run-work-folding-completed-before-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking the earlier launch notes.",
          runId: "run-work-folding-completed-before-active",
          createdAt: "2026-06-09T10:00:10Z",
        },
        {
          role: "assistant",
          content: "The earlier launch summary is ready.",
          runId: "run-work-folding-completed-before-active",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:20Z",
        },
        {
          role: "user",
          content: "Investigate the current launch",
          runId: "run-work-folding-active-later",
          createdAt: "2026-06-09T10:05:00Z",
        },
        {
          role: "assistant",
          content: "Checking the current launch notes.",
          runId: "run-work-folding-active-later",
          createdAt: "2026-06-09T10:05:10Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-completed-before-active",
    });

    const expandButtons = await screen.findAllByLabelText(
      "Expand work history",
    );
    expect(expandButtons).toHaveLength(1);
    expect(expandButtons[0]).toHaveTextContent("Worked for 20s");
    expect(
      screen.getByText("Summarize the earlier launch"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking the earlier launch notes.")).toBeNull();
    expect(
      screen.getByText("The earlier launch summary is ready."),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Investigate the current launch"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Checking the current launch notes."),
    ).toBeInTheDocument();
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
          content: "Checking launch status.",
          runId: "run-work-folding-completed",
          createdAt: "2026-06-09T10:00:25Z",
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
    });

    const expandButton = await screen.findByLabelText("Expand work history");
    expect(expandButton).toHaveTextContent("Worked for 55s");
    expect(expandButton.querySelectorAll('[aria-hidden="true"]')).toHaveLength(
      2,
    );
    const foldedAssistantGroup = expandButton.closest(
      '[data-role="assistant"]',
    ) as HTMLElement | null;
    expect(foldedAssistantGroup).not.toBeNull();
    expect(foldedAssistantGroup).not.toHaveClass("group");
    expect(
      within(foldedAssistantGroup!).getAllByLabelText("View agent profile"),
    ).toHaveLength(1);
    expect(screen.getByText("Summarize the launch status")).toBeInTheDocument();
    expect(screen.queryByText("Checking launch status.")).toBeNull();
    expect(
      screen.getByText("Launch status is summarized."),
    ).toBeInTheDocument();

    click(expandButton);

    await waitFor(() => {
      expect(
        within(foldedAssistantGroup!).getByText("Checking launch status."),
      ).toBeInTheDocument();
      expect(
        within(foldedAssistantGroup!).getAllByLabelText("View agent profile"),
      ).toHaveLength(1);
      expectTextBefore(
        foldedAssistantGroup!,
        "Worked for 55s",
        "Checking launch status.",
      );
      expectTextBefore(
        foldedAssistantGroup!,
        "Checking launch status.",
        "Launch status is summarized.",
      );
      expect(screen.getByLabelText("Collapse work history")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });

    click(screen.getByLabelText("Collapse work history"));

    await waitFor(() => {
      expect(
        screen.getByText("Summarize the launch status"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Checking launch status.")).toBeNull();
      expect(screen.getByLabelText("Expand work history")).toHaveAttribute(
        "aria-expanded",
        "false",
      );
    });
  });

  it("folds completed chat work without hiding the answer before the lifecycle marker", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-completion-marker",
      chatMessages: [
        {
          role: "user",
          content: "Summarize the production launch status",
          runId: "run-work-folding-completion-marker",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking production launch status.",
          runId: "run-work-folding-completion-marker",
          createdAt: "2026-06-09T10:00:25Z",
        },
        {
          role: "assistant",
          content: "The production launch status is ready.",
          runId: "run-work-folding-completion-marker",
          createdAt: "2026-06-09T10:00:55Z",
        },
        {
          role: "assistant",
          content: null,
          runId: "run-work-folding-completion-marker",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:56Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-completion-marker",
    });

    const expandButton = await screen.findByLabelText("Expand work history");
    expect(expandButton).toHaveTextContent("Worked for 56s");
    expect(
      screen.getByText("Summarize the production launch status"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Checking production launch status.")).toBeNull();
    expect(
      screen.getByText("The production launch status is ready."),
    ).toBeInTheDocument();

    click(expandButton);

    await waitFor(() => {
      expect(
        screen.getByText("Checking production launch status."),
      ).toBeInTheDocument();
      expect(
        screen.getByText("The production launch status is ready."),
      ).toBeInTheDocument();
    });
  });

  it("folds each completed run independently", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-each-run",
      chatMessages: [
        {
          role: "user",
          content: "Summarize the first launch",
          runId: "run-work-folding-first",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Checking the first launch notes.",
          runId: "run-work-folding-first",
          createdAt: "2026-06-09T10:00:10Z",
        },
        {
          role: "assistant",
          content: "The first launch summary is ready.",
          runId: "run-work-folding-first",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:20Z",
        },
        {
          role: "user",
          content: "Summarize the second launch",
          runId: "run-work-folding-second",
          createdAt: "2026-06-09T10:05:00Z",
        },
        {
          role: "assistant",
          content: "Checking the second launch notes.",
          runId: "run-work-folding-second",
          createdAt: "2026-06-09T10:05:25Z",
        },
        {
          role: "assistant",
          content: "The second launch summary is ready.",
          runId: "run-work-folding-second",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:05:55Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-each-run",
    });

    const expandButtons = await screen.findAllByLabelText(
      "Expand work history",
    );
    expect(expandButtons).toHaveLength(2);
    expect(expandButtons[0]).toHaveTextContent("Worked for 20s");
    expect(expandButtons[1]).toHaveTextContent("Worked for 55s");
    const secondAssistantGroup = expandButtons[1]!.closest(
      '[data-role="assistant"]',
    ) as HTMLElement | null;
    expect(secondAssistantGroup).not.toBeNull();
    expect(screen.getByText("Summarize the first launch")).toBeInTheDocument();
    expect(screen.queryByText("Checking the first launch notes.")).toBeNull();
    expect(
      screen.getByText("The first launch summary is ready."),
    ).toBeInTheDocument();
    expect(screen.getByText("Summarize the second launch")).toBeInTheDocument();
    expect(screen.queryByText("Checking the second launch notes.")).toBeNull();
    expect(
      screen.getByText("The second launch summary is ready."),
    ).toBeInTheDocument();

    click(expandButtons[1]!);

    await waitFor(() => {
      expect(
        screen.getByText("Summarize the first launch"),
      ).toBeInTheDocument();
      expect(screen.queryByText("Checking the first launch notes.")).toBeNull();
      expect(
        screen.getByText("Summarize the second launch"),
      ).toBeInTheDocument();
      expect(
        within(secondAssistantGroup!).getByText(
          "Checking the second launch notes.",
        ),
      ).toBeInTheDocument();
      expect(
        within(secondAssistantGroup!).getAllByLabelText("View agent profile"),
      ).toHaveLength(1);
      expectTextBefore(
        secondAssistantGroup!,
        "Worked for 55s",
        "Checking the second launch notes.",
      );
      expectTextBefore(
        secondAssistantGroup!,
        "Checking the second launch notes.",
        "The second launch summary is ready.",
      );
      expect(screen.getByLabelText("Collapse work history")).toHaveAttribute(
        "aria-expanded",
        "true",
      );
    });
  });

  it("does not fold a completed run with only a user message and final reply", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-user-final-only",
      chatMessages: [
        {
          role: "user",
          content: "Answer directly",
          runId: "run-work-folding-user-final-only",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: "Direct answer.",
          runId: "run-work-folding-user-final-only",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:05Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-user-final-only",
    });

    await waitFor(() => {
      expect(screen.getByText("Answer directly")).toBeInTheDocument();
      expect(screen.getByText("Direct answer.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("does not fold a completed run when the only prior assistant message is thinking", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-thinking-only",
      chatMessages: [
        {
          role: "user",
          content: "Summarize the launch status",
          runId: "run-work-folding-thinking-only",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          role: "assistant",
          content: null,
          thinking: "Reviewing launch context",
          runId: "run-work-folding-thinking-only",
          createdAt: "2026-06-09T10:00:05Z",
        },
        {
          role: "assistant",
          content: "Launch status is ready.",
          runId: "run-work-folding-thinking-only",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:05Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-thinking-only",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Summarize the launch status"),
      ).toBeInTheDocument();
      expect(screen.getByText("Launch status is ready.")).toBeInTheDocument();
      expect(screen.queryByText("Worked for 5s")).not.toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
    });
  });

  it("does not fold a completed run with a single message", async () => {
    mockChatLifecycle(context, {
      threadId: "thread-work-folding-single-message",
      chatMessages: [
        {
          role: "assistant",
          content: "Standalone run result.",
          runId: "run-work-folding-single",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: "/chats/thread-work-folding-single-message",
    });

    await waitFor(() => {
      expect(screen.getByText("Standalone run result.")).toBeInTheDocument();
      expect(screen.queryByLabelText("Expand work history")).toBeNull();
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
      return respond(200, {
        lastReadMessageId: null,
        unreads: [],
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Baseline 0")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(screen.getByText("Burst 119")).toBeInTheDocument();
    });
  });

  it("silently loads older chat history after rendering latest messages", async () => {
    const olderReply = "Earlier launch notes from last week.";
    const beforeHistoryGate = context.mocks.deferred<void>();

    mockChatLifecycle(context, {
      threadId: HISTORY_THREAD_ID,
      threadTitle: "History review",
      beforeHistoryGate: beforeHistoryGate.promise,
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
    });
    expect(queryButtonByText("Load history")).toBeNull();
    expect(screen.queryByText(olderReply)).not.toBeInTheDocument();

    beforeHistoryGate.resolve();

    await waitFor(() => {
      expect(screen.getByText(olderReply)).toBeInTheDocument();
      expect(queryButtonByText("Load history")).toBeNull();
    });
  });

  it("keeps chat scroll controls responsive to buttons and keyboard", async () => {
    mockResizeObserver();
    mockChatLifecycle(context, {
      threadId: "scroll-history-thread",
      threadTitle: "Scroll history",
      chatMessages: Array.from({ length: 8 }, (_, index) => {
        return makeMessage(
          `scroll-message-${index}`,
          `Visible launch update ${index}`,
        );
      }),
    });

    detachedSetupPage({ context, path: "/chats/scroll-history-thread" });

    let scrollContainer: HTMLElement | undefined;
    await waitFor(() => {
      scrollContainer = chatScrollContainer();
      expect(scrollContainer).toBeInTheDocument();
    });
    if (scrollContainer === undefined) {
      throw new Error("Chat scroll container not found");
    }
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1200,
      clientHeight: 300,
    });

    await waitFor(() => {
      expect(screen.getByText("Visible launch update 7")).toBeInTheDocument();
      expect(queryButtonByText("Load history")).toBeNull();
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
    fireEvent.scroll(scrollContainer);
    const composer = screen.getByPlaceholderText(PLACEHOLDER);
    composer.focus();
    fireEvent.keyDown(composer, { key: "ArrowUp" });
    expect(scrollContainer.scrollTop).toBe(420);

    setScrollMetrics(scrollContainer, {
      scrollHeight: 1500,
      clientHeight: 300,
    });
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "ArrowDown", ctrlKey: true });
    expect(scrollContainer.scrollTop).toBe(1500);
  });

  it("renders the latest chat groups first and prepends older in-memory groups near the top", async () => {
    mockResizeObserver();
    let markReadCalls = 0;
    const threadId = "render-window-thread";
    const chatMessages: PagedChatMessage[] = Array.from(
      { length: 24 },
      (_, index) => {
        return {
          id: `render-window-message-${index}`,
          role: "assistant",
          content: `Render window reply ${index}`,
          runId: `render-window-run-${index}`,
          runLifecycleEvent: "completed",
          createdAt: `2026-06-09T10:${String(index).padStart(2, "0")}:00Z`,
        };
      },
    );

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Render window",
      chatMessages,
    });
    context.mocks.api(chatThreadMarkReadContract.markRead, ({ respond }) => {
      markReadCalls += 1;
      return respond(200, {
        lastReadMessageId: "render-window-message-23",
        unreads: [],
      });
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Render window reply 23")).toBeInTheDocument();
      expect(screen.queryByText("Render window reply 13")).toBeNull();
      expect(markReadCalls).toBeGreaterThan(0);
    });

    const scrollContainer = chatScrollContainer();
    setScrollMetrics(scrollContainer, {
      scrollHeight: 1000,
      clientHeight: 300,
    });
    scrollContainer.scrollTop = 80;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => {
      expect(screen.getByText("Render window reply 4")).toBeInTheDocument();
    });
    expect(screen.queryByText("Render window reply 3")).toBeNull();

    scrollContainer.scrollTop = 80;
    fireEvent.scroll(scrollContainer);

    await waitFor(() => {
      expect(screen.getByText("Render window reply 3")).toBeInTheDocument();
    });

    scrollContainer.scrollTop = 80;
    fireEvent.scroll(scrollContainer);
    await Promise.resolve();
    await Promise.resolve();
    expect(screen.getByText("Render window reply 3")).toBeInTheDocument();
  });

  it("counts a folded tail run group as one item in the initial chat window", async () => {
    const threadId = "render-window-tail-run-group";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Tail run group window",
      chatMessages: [
        ...makeRunGroupMessages({
          label: "A",
          count: 11,
          runGroupId: "tail-group-a",
          startMinute: 0,
        }),
        ...makeRunGroupMessages({
          label: "B",
          count: 1,
          runGroupId: "tail-group-b",
          startMinute: 30,
        }),
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Tail run group window")).toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "10 runs",
      );
      expect(screen.getByText("A reply 11")).toBeInTheDocument();
      expect(screen.getByText("B reply 1")).toBeInTheDocument();
      expect(screen.queryByText("A reply 10")).not.toBeInTheDocument();
    });
  });

  it("keeps the item before a folded middle run group in the initial chat window", async () => {
    const threadId = "render-window-middle-run-group";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Middle run group window",
      chatMessages: [
        ...makeRunGroupMessages({
          label: "A",
          count: 1,
          runGroupId: "middle-group-a",
          startMinute: 0,
        }),
        ...makeRunGroupMessages({
          label: "B",
          count: 10,
          runGroupId: "middle-group-b",
          startMinute: 10,
        }),
        ...makeRunGroupMessages({
          label: "C",
          count: 1,
          runGroupId: "middle-group-c",
          startMinute: 30,
        }),
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Middle run group window")).toBeInTheDocument();
      expect(screen.getByText("A reply 1")).toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "9 runs",
      );
      expect(screen.getByText("B reply 10")).toBeInTheDocument();
      expect(screen.getByText("C reply 1")).toBeInTheDocument();
      expect(screen.queryByText("B reply 9")).not.toBeInTheDocument();
    });
  });

  it("moves between chat threads with keyboard shortcuts", async () => {
    const resizeObserver = mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
      featureSwitches: { [FeatureSwitchKey.ChatThreadEmoji]: true },
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
      expect(screen.getByText("Rename chat")).toBeInTheDocument();
      expect(screen.getByText("Change emoji")).toBeInTheDocument();
      expect(screen.getAllByText("F2")).toHaveLength(2);
      expect(screen.getAllByText("Shift").length).toBeGreaterThan(0);
    });
  });

  it("hides the chat emoji shortcut when the feature switch is off", async () => {
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText("Current keyboard thread").length,
      ).toBeGreaterThan(0);
    });

    expect(screen.queryByLabelText("Change emoji")).not.toBeInTheDocument();

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "F2", shiftKey: true });

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
  });

  it("opens the current chat rename dialog with F2", async () => {
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
      featureSwitches: { [FeatureSwitchKey.ChatThreadEmoji]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText("Current keyboard thread").length,
      ).toBeGreaterThan(0);
    });
    const emojiButton = screen.getByLabelText("Change emoji");
    expect(emojiButton).toHaveTextContent("");
    expect(emojiButton.querySelector("svg")).not.toBeInTheDocument();
    expect(emojiButton).toHaveClass("h-7", "w-7");

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "F2" });

    let dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      "Current keyboard thread",
    );

    click(buttonByText("Cancel"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Rename chat" }),
      ).not.toBeInTheDocument();
    });

    const composer = chatComposerTextarea();
    composer.focus();
    fireEvent.keyDown(composer, { key: "F2" });

    dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      "Current keyboard thread",
    );
  });

  it("keeps F2 rename available after renaming the current chat", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByText("Current keyboard thread")).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    await user.keyboard("{F2}");

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    await fill(
      within(dialog).getByPlaceholderText("Chat title"),
      "Renamed keyboard thread",
    );
    click(buttonByText("Rename"));

    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Rename chat" }),
      ).not.toBeInTheDocument();
    });

    await waitFor(() => {
      expect(activeElementIsInside(threadRegion)).toBeTruthy();
    });

    await user.keyboard("{F2}");

    const reopenedDialog = await screen.findByRole("dialog", {
      name: "Rename chat",
    });
    expect(
      within(reopenedDialog).getByPlaceholderText("Chat title"),
    ).toHaveValue("Current keyboard thread");
  });

  it("keeps F2 rename available after creating a chat from the agent composer", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    mockChatLifecycle(context);

    detachedSetupPage({ context, path: AGENT_CHAT_PATH });

    const textarea = await waitFor(() => {
      return screen.getByPlaceholderText(PLACEHOLDER) as HTMLTextAreaElement;
    });
    await sendMessageInUI(user, textarea, "Name this thread from F2");

    await waitFor(() => {
      expect(screen.getByText("Name this thread from F2")).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    expect(activeElementIsInside(threadRegion)).toBeTruthy();

    await user.keyboard("{F2}");

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue("");
  });

  it("renames the main chat with F2 when a side chat is focused", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    mockKeyboardNavigationThreads();

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread?sidebar=keyboard-next-thread",
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByText("Next thread launch note")).toBeInTheDocument();
    });

    const threadRegions = screen.getAllByLabelText("Chat thread");
    expect(threadRegions).toHaveLength(2);
    threadRegions[1]?.focus();

    await user.keyboard("{F2}");

    const dialog = await screen.findByRole("dialog", { name: "Rename chat" });
    expect(within(dialog).getByPlaceholderText("Chat title")).toHaveValue(
      "Current keyboard thread",
    );
  });

  it("adds an emoji to the current chat with Shift+F2", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentDetailTitle: null });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
      featureSwitches: { [FeatureSwitchKey.ChatThreadEmoji]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(
        screen.getAllByText("Current keyboard thread").length,
      ).toBeGreaterThan(0);
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "F2", shiftKey: true });

    const menu = await screen.findByRole("menu");
    expect(queryAllByRoleFast("menuitem", menu)).toHaveLength(10);
    click(menuItemByLabel("Done ✅", menu));

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "keyboard-current-thread",
        "✅",
      );
    });
  });

  it("adds an emoji to the current chat directly with Shift+1", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentDetailTitle: null });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
      featureSwitches: { [FeatureSwitchKey.ChatThreadEmoji]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, {
      key: "1",
      code: "Digit1",
      shiftKey: true,
    });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "keyboard-current-thread",
        "✅",
      );
    });
    expect(screen.queryByRole("menu")).not.toBeInTheDocument();
  });

  it("does not refocus the chat emoji button or show its tooltip after closing the picker from outside", async () => {
    const user = userEvent.setup({ delay: null });
    mockResizeObserver();
    mockKeyboardNavigationThreads({
      currentTitle: "🔥 Current keyboard thread",
    });

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
      featureSwitches: { [FeatureSwitchKey.ChatThreadEmoji]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(screen.getByLabelText("Change emoji")).toHaveTextContent("🔥");
    });

    const emojiButton = screen.getByLabelText("Change emoji");
    function visibleChatThreadIconTooltip(): HTMLElement | undefined {
      return screen.queryAllByText("Chat thread icon").find((element) => {
        try {
          expect(element).toBeVisible();
          return true;
        } catch {
          return false;
        }
      });
    }

    await user.hover(emojiButton);
    await waitFor(() => {
      expect(visibleChatThreadIconTooltip()).toBeDefined();
    });

    await user.click(emojiButton);
    await expect(screen.findByRole("menu")).resolves.toBeInTheDocument();

    fireEvent.pointerOut(emojiButton);
    fireEvent.mouseOut(emojiButton);
    click(document.body);

    await waitFor(() => {
      expect(screen.queryByRole("menu")).not.toBeInTheDocument();
    });
    await waitFor(() => {
      expect(visibleChatThreadIconTooltip()).toBeUndefined();
      expect(emojiButton).not.toHaveFocus();
    });
  });

  it("replaces the current chat emoji from the Shift+F2 picker", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({
      currentTitle: "🔥   Current keyboard thread",
    });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
      featureSwitches: { [FeatureSwitchKey.ChatThreadEmoji]: true },
    });

    await waitFor(() => {
      expect(
        screen.getByText("Current thread launch note"),
      ).toBeInTheDocument();
      expect(document.title).toBe("🔥   Current keyboard thread | VM0");
      expect(screen.getByLabelText("Change emoji")).toHaveTextContent("🔥");
      expect(screen.getByText("Current keyboard thread")).toBeInTheDocument();
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, { key: "F2", shiftKey: true });

    const menu = await screen.findByRole("menu");
    expect(
      queryAllByRoleFast("menuitem", menu).some((item) => {
        return item.getAttribute("aria-label") === "Important 📌";
      }),
    ).toBeFalsy();
    fireEvent.keyDown(menu, { key: "1", code: "Digit1", shiftKey: true });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "keyboard-current-thread",
        "✅ Current keyboard thread",
      );
    });
  });

  it("clears the current chat emoji directly with Shift+0", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({
      currentTitle: "🔥 Current keyboard thread",
    });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
      featureSwitches: { [FeatureSwitchKey.ChatThreadEmoji]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Change emoji")).toHaveTextContent("🔥");
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, {
      key: "0",
      code: "Digit0",
      shiftKey: true,
    });

    await waitFor(() => {
      expect(renameRequest).toHaveBeenCalledWith(
        "keyboard-current-thread",
        "Current keyboard thread",
      );
    });
  });

  it("does not clear the emoji when the chat has no other title text", async () => {
    const renameRequest = vi.fn();
    mockResizeObserver();
    mockKeyboardNavigationThreads({ currentTitle: "🔥" });
    context.mocks.api(
      chatThreadRenameContract.rename,
      ({ body, params, respond }) => {
        renameRequest(params.id, body.title);
        return respond(204);
      },
    );

    detachedSetupPage({
      context,
      path: "/chats/keyboard-current-thread",
      featureSwitches: { [FeatureSwitchKey.ChatThreadEmoji]: true },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Change emoji")).toHaveTextContent("🔥");
    });

    const threadRegion = screen.getByLabelText("Chat thread");
    threadRegion.focus();
    fireEvent.keyDown(threadRegion, {
      key: "0",
      code: "Digit0",
      shiftKey: true,
    });

    expect(renameRequest).not.toHaveBeenCalled();
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

  it("starts a workflow prompt from an assistant message when the composer is empty", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "assistant-message-create-workflow-empty";
    const assistantReply = "We can turn this into a workflow.";
    mockWorkflowComposerWorkflows();
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Assistant workflow",
      chatMessages: [
        {
          id: "msg-workflow-empty-user",
          role: "user",
          content: "Make this repeatable",
          runId: "run-workflow-empty",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-empty-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-workflow-empty",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.WorkflowAutomation]: true,
      },
    });

    const assistantMessage = await screen.findByText(assistantReply);
    const assistantGroup = assistantMessage.closest('[data-role="assistant"]');
    if (!(assistantGroup instanceof HTMLElement)) {
      throw new Error("assistant message group not found");
    }
    const copyButton = within(assistantGroup).getByLabelText("Copy message");
    const workflowButton =
      within(assistantGroup).getByLabelText("Create workflow");
    expect(
      copyButton.compareDocumentPosition(workflowButton) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();

    await user.hover(workflowButton);
    const workflowTooltip = await screen.findByText("Create workflow", {
      selector: "div",
    });
    await waitFor(() => {
      expect(workflowTooltip).toBeVisible();
    });
    await user.unhover(workflowButton);

    click(workflowButton);

    const editor = await findWorkflowComposerEditor();
    await waitFor(() => {
      expect(editor).toHaveTextContent(CREATE_WORKFLOW_WITH_CHAT_PROMPT);
    });
    expect(
      screen.queryByRole("dialog", { name: "Replace composer draft?" }),
    ).not.toBeInTheDocument();
  });

  it("confirms before replacing an existing composer draft with a workflow prompt", async () => {
    const threadId = "assistant-message-create-workflow-draft";
    const assistantReply = "This is a good workflow candidate.";
    const draft = "Keep this draft";
    mockWorkflowComposerWorkflows();
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Assistant workflow draft",
      chatMessages: [
        {
          id: "msg-workflow-draft-user",
          role: "user",
          content: "Can this be automated?",
          runId: "run-workflow-draft",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-draft-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-workflow-draft",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.WorkflowAutomation]: true,
      },
    });

    const editor = await findWorkflowComposerEditor();
    await fill(editor, draft);
    await waitFor(() => {
      expect(editor).toHaveTextContent(draft);
    });

    const assistantMessage = await screen.findByText(assistantReply);
    const assistantGroup = assistantMessage.closest('[data-role="assistant"]');
    if (!(assistantGroup instanceof HTMLElement)) {
      throw new Error("assistant message group not found");
    }
    const workflowButton =
      within(assistantGroup).getByLabelText("Create workflow");

    click(workflowButton);

    const dialog = await screen.findByRole("dialog", {
      name: "Replace composer draft?",
    });
    expect(
      within(dialog).getByText(
        "Continuing will clear your current composer draft and start a workflow prompt.",
      ),
    ).toBeInTheDocument();

    click(buttonByText("Cancel", dialog));
    await waitFor(() => {
      expect(
        screen.queryByRole("dialog", { name: "Replace composer draft?" }),
      ).not.toBeInTheDocument();
      expect(editor).toHaveTextContent(draft);
    });

    click(workflowButton);
    const confirmDialog = await screen.findByRole("dialog", {
      name: "Replace composer draft?",
    });
    click(buttonByText("Continue", confirmDialog));

    await waitFor(() => {
      expect(editor).toHaveTextContent(CREATE_WORKFLOW_WITH_CHAT_PROMPT);
      expect(editor).not.toHaveTextContent(draft);
    });
  });

  it("hides the workflow prompt action when workflow automation is disabled", async () => {
    const threadId = "assistant-message-create-workflow-disabled";
    const assistantReply = "This could be automated later.";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Assistant workflow disabled",
      chatMessages: [
        {
          id: "msg-workflow-disabled-user",
          role: "user",
          content: "Can this repeat?",
          runId: "run-workflow-disabled",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-disabled-assistant",
          role: "assistant",
          content: assistantReply,
          runId: "run-workflow-disabled",
          createdAt: "2026-06-09T10:01:00Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.WorkflowAutomation]: false,
      },
    });

    const assistantMessage = await screen.findByText(assistantReply);
    const assistantGroup = assistantMessage.closest('[data-role="assistant"]');
    if (!(assistantGroup instanceof HTMLElement)) {
      throw new Error("assistant message group not found");
    }
    expect(
      within(assistantGroup).queryByLabelText("Create workflow"),
    ).not.toBeInTheDocument();
  });

  it("shows linked automations from the chat header sidebar", async () => {
    mockAutomationThread();
    context.mocks.api(chatThreadArtifactsContract.list, ({ respond }) => {
      return respond(200, { runs: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${AUTOMATION_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(
        screen.getAllByText("Scheduled launch review").length,
      ).toBeGreaterThan(0);
      expect(buttonByLabel("Automations")).toBeInTheDocument();
    });

    click(buttonByLabel("Automations"));

    await waitFor(() => {
      expect(screen.getByTestId("automation-sidebar")).toBeInTheDocument();
    });

    const sidebar = screen.getByTestId("automation-sidebar");
    expect(within(sidebar).getByText("Launch review")).toBeInTheDocument();
    expect(
      within(sidebar).getByText("Paused launch audit"),
    ).toBeInTheDocument();
    expect(
      within(sidebar).getByText("Manual launch reminder"),
    ).toBeInTheDocument();
    expect(within(sidebar).getAllByText("Status")).toHaveLength(3);
    expect(within(sidebar).getAllByText("Schedule")).toHaveLength(3);
    expect(within(sidebar).getAllByText("Next run")).toHaveLength(3);
    expect(within(sidebar).getAllByText("Run now")).toHaveLength(3);
    expect(within(sidebar).getAllByText("Edit")).toHaveLength(3);
    expect(within(sidebar).getAllByText("No upcoming run")).toHaveLength(2);
    expect(within(sidebar).queryByText("Description")).not.toBeInTheDocument();
    expect(
      within(sidebar).queryByText(/linked to this chat/u),
    ).not.toBeInTheDocument();
    expect(
      within(sidebar).queryByText(/active.*paused/u),
    ).not.toBeInTheDocument();
    expect(within(sidebar).queryByRole("searchbox")).not.toBeInTheDocument();

    click(screen.getByLabelText("Open artifacts"));

    await waitFor(() => {
      expect(screen.getByTestId("artifact-inbox")).toBeInTheDocument();
      expect(
        screen.queryByTestId("automation-sidebar"),
      ).not.toBeInTheDocument();
    });
  });

  it("opens a linked automation detail from the chat header", async () => {
    mockAutomationThread();

    detachedSetupPage({
      context,
      path: `/chats/${AUTOMATION_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(buttonByLabel("Automations")).toBeInTheDocument();
    });

    click(buttonByLabel("Automations"));

    await waitFor(() => {
      expect(screen.getByText("Launch review")).toBeInTheDocument();
    });

    click(
      within(screen.getByTestId("automation-sidebar")).getAllByText("Edit")[0]!,
    );

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Launch review" }),
      ).toBeInTheDocument();
    });
  });

  it("lists workflow automations in the sidebar", async () => {
    mockAutomationThread();
    setMockWorkflowTriggers([
      createMockWorkflowTrigger({
        id: "e0000001-0000-4000-a000-000000000002",
        chatThreadId: AUTOMATION_THREAD_ID,
        kind: "schedule",
        scheduleSummary: "Every 60s",
        workflow: {
          id: "a0000001-0000-4000-a000-000000000002",
          name: "nightly-sync",
          displayName: "Nightly sync",
          description: "Sync the changelog every night",
        },
      }),
    ]);
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

    const sidebar = screen.getByTestId("automation-sidebar");
    expect(within(sidebar).getByText("Nightly sync")).toBeInTheDocument();
    expect(within(sidebar).getByText("View")).toBeInTheDocument();
    expect(within(sidebar).getAllByText("Schedule").length).toBeGreaterThan(0);
    expect(within(sidebar).getByText("Every 1 minute")).toBeInTheDocument();
    expect(within(sidebar).getByText("Last run")).toBeInTheDocument();
    expect(within(sidebar).getByText("No runs yet")).toBeInTheDocument();
    expect(within(sidebar).getAllByText("Next run").length).toBeGreaterThan(0);
    expect(
      within(sidebar).getAllByText("No upcoming run").length,
    ).toBeGreaterThan(0);
    expect(
      within(sidebar).queryByText("Authorization"),
    ).not.toBeInTheDocument();

    click(within(sidebar).getAllByText("Edit").at(-1)!);

    await waitFor(() => {
      expect(
        screen.getByRole("dialog", { name: "Edit automation" }),
      ).toBeInTheDocument();
    });
    const editDialog = screen.getByRole("dialog", {
      name: "Edit automation",
    });
    expect(
      within(editDialog).getByRole("combobox", { name: "Every" }),
    ).toHaveTextContent("1 minute");
    expect(
      within(editDialog).queryByLabelText("Interval seconds"),
    ).not.toBeInTheDocument();
  });

  it("updates a schedule workflow automation from the sidebar", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    const sidebar = await openAutomationSidebarWithWorkflowTrigger(
      createMockWorkflowTrigger({
        id: "e0000001-0000-4000-a000-000000000003",
        chatThreadId: AUTOMATION_THREAD_ID,
        kind: "schedule",
        schedule: { type: "loop", intervalSeconds: 3600 },
        scheduleSummary: "Every 3600s",
      }),
    );
    mockWorkflowTriggerUpdate((triggerId, body) => {
      updateBodies.push({ triggerId, body });
    });

    click(within(sidebar).getAllByText("Edit").at(-1)!);

    const dialog = await screen.findByRole("dialog", {
      name: "Edit automation",
    });
    selectOptionByLabel("Every", "30 minutes", dialog);
    click(buttonByText("Save automation", dialog));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: "e0000001-0000-4000-a000-000000000003",
        body: {
          schedule: {
            type: "loop",
            intervalSeconds: 1800,
          },
        },
      });
    });
  });

  it("updates a Gmail workflow automation match from the sidebar", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    const sidebar = await openAutomationSidebarWithWorkflowTrigger(
      createMockWorkflowTrigger({
        id: "e0000001-0000-4000-a000-000000000004",
        chatThreadId: AUTOMATION_THREAD_ID,
        kind: "event",
        eventType: "gmail-new-message",
        eventConfig: {
          provider: "gmail",
          event: "new_message",
          match: {
            subject: { doesNotContain: "newsletter" },
          },
        },
      }),
    );
    mockWorkflowTriggerUpdate((triggerId, body) => {
      updateBodies.push({ triggerId, body });
    });

    click(within(sidebar).getAllByText("Edit").at(-1)!);

    const dialog = await screen.findByRole("dialog", {
      name: "Edit automation",
    });
    await fill(within(dialog).getByLabelText("From contains"), "@acme.com");
    await fill(within(dialog).getByLabelText("Body contains"), "invoice");
    click(buttonByText("Save automation", dialog));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: "e0000001-0000-4000-a000-000000000004",
        body: {
          eventConfig: {
            provider: "gmail",
            event: "new_message",
            match: {
              from: { contains: "@acme.com" },
              subject: { doesNotContain: "newsletter" },
              body: { contains: "invoice" },
            },
          },
        },
      });
    });
  });

  it("updates a Gmail label workflow automation from the sidebar", async () => {
    const updateBodies: {
      readonly triggerId: string;
      readonly body: ZeroWorkflowTriggerUpdateRequest;
    }[] = [];
    const sidebar = await openAutomationSidebarWithWorkflowTrigger(
      createMockWorkflowTrigger({
        id: "e0000001-0000-4000-a000-000000000005",
        chatThreadId: AUTOMATION_THREAD_ID,
        kind: "event",
        eventType: "gmail-label-applied",
        eventConfig: {
          provider: "gmail",
          event: "label_applied",
          labelName: "Support",
        },
      }),
    );
    mockWorkflowTriggerUpdate((triggerId, body) => {
      updateBodies.push({ triggerId, body });
    });

    click(within(sidebar).getAllByText("Edit").at(-1)!);

    const dialog = await screen.findByRole("dialog", {
      name: "Edit automation",
    });
    await fill(within(dialog).getByLabelText("Label name"), "Escalated");
    click(buttonByText("Save automation", dialog));

    await waitFor(() => {
      expect(updateBodies.at(-1)).toStrictEqual({
        triggerId: "e0000001-0000-4000-a000-000000000005",
        body: {
          eventConfig: {
            provider: "gmail",
            event: "label_applied",
            labelName: "Escalated",
          },
        },
      });
    });
  });

  it("folds goal-state markers into the goal row beneath the queued messages", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-goal-fold";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-goal-user",
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-assistant",
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
        // Goal-state marker carrying the objective brief; the fold should
        // surface the goal while keeping the marker out of transcript bubbles.
        {
          id: "msg-goal-active",
          runId: undefined,
          role: "assistant",
          content: null,
          goalEvent: {
            type: "state",
            status: "active",
            objectiveBrief: "Drive the release to merge",
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });
    let pausedGoalThreadId: string | null = null;
    context.mocks.api(
      zeroGoalsContract.pauseForChatThread,
      ({ params, respond }) => {
        pausedGoalThreadId = params.threadId;
        return respond(200, {
          objective: "Drive the release to merge",
          objectiveBrief: "Drive the release to merge",
          status: "paused",
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });

    // The folded goal surfaces above the composer.
    await waitFor(() => {
      expect(screen.getByLabelText("Active goal")).toHaveTextContent(
        "Drive the release to merge",
      );
    });
    // The marker is a control row — it must not also render as a chat bubble.
    expect(screen.getAllByText("Drive the release to merge")).toHaveLength(1);

    // The goal is the lowest-priority row: it sits after every queued message.
    await sendQueuedMessage(user, "First queued follow-up");
    await expectQueuedMessages(["First queued follow-up"]);
    const goalRow = screen.getByLabelText("Active goal");
    const strip = goalRow.closest('[role="list"]');
    expect(strip).not.toBeNull();
    const rows = within(strip as HTMLElement).getAllByRole("listitem");
    const goalIndex = rows.indexOf(goalRow);
    const queuedIndex = rows.findIndex((row) => {
      return row.getAttribute("aria-label") === "Queued message";
    });
    expect(queuedIndex).toBeGreaterThanOrEqual(0);
    expect(goalIndex).toBeGreaterThan(queuedIndex);

    // Cancelling the goal row pauses the active goal by thread.
    await user.click(within(goalRow).getByLabelText("Cancel goal"));
    await waitFor(() => {
      expect(pausedGoalThreadId).toBe(threadId);
    });
  });

  it("opens an active goal objective dialog from the goal row", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "thread-goal-dialog";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-goal-dialog-user",
          role: "user",
          content: "Start the active run",
          runId: "run-active",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-dialog-assistant",
          role: "assistant",
          content: null,
          runId: "run-active",
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-goal-dialog-active",
          runId: undefined,
          role: "assistant",
          content: null,
          goalEvent: {
            type: "state",
            status: "active",
            objectiveBrief: "Release brief",
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });
    let requestedThreadId: string | null = null;
    context.mocks.api(
      zeroGoalsContract.getForChatThread,
      ({ params, respond }) => {
        requestedThreadId = params.threadId;
        return respond(200, {
          objective: "# Full goal\n\n- Keep **shipping**\n- Review `objective`",
          objectiveBrief: "Release brief",
          status: "active",
        });
      },
    );

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    const goalRow = await screen.findByLabelText("Active goal");
    await user.click(within(goalRow).getByLabelText("Open goal details"));

    const dialog = await screen.findByRole("dialog", { name: "Goal" });
    expect(requestedThreadId).toBe(threadId);
    expect(
      within(dialog).getByRole("heading", { name: "Full goal" }),
    ).toBeInTheDocument();
    expect(dialog.querySelector(".wmde-markdown")).not.toBeNull();
  });

  it("hides the goal row once a completion marker folds in", async () => {
    const threadId = "thread-goal-complete";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-goalc-active",
          runId: undefined,
          role: "assistant",
          content: null,
          goalEvent: {
            type: "state",
            status: "active",
            objectiveBrief: "Drive the release to merge",
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goalc-complete",
          runId: undefined,
          role: "assistant",
          content: null,
          goalEvent: { type: "state", status: "complete" },
          createdAt: "2026-06-09T10:00:02Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByLabelText("Send")).toBeInTheDocument();
    });
    // Latest state marker is complete → no goal row.
    expect(screen.queryByLabelText("Active goal")).not.toBeInTheDocument();
  });

  it("shows automation run messages as automation links in chat history", async () => {
    const threadId = "thread-automation-message";
    const automationId = "f0000001-0000-4000-a000-000000000721";
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Automation message",
      chatMessages: [
        {
          id: "msg-automation-user",
          role: "user",
          content: "Review launch risks",
          automationId,
          automationSnapshot: {
            id: automationId,
            title: "Launch risk review",
            description: "Launch review",
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-automation-assistant",
          role: "assistant",
          content: "I'll review the launch risks on schedule.",
          createdAt: "2026-06-09T10:00:01Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText("Automation message")).toBeInTheDocument();
      expect(screen.getByText("Launch review")).toBeInTheDocument();
      expect(
        screen.getByLabelText("Open automation Launch review"),
      ).toHaveAttribute("href", `/automations/${automationId}`);
      expect(screen.queryByText("Review launch risks")).not.toBeInTheDocument();
    });
  });

  it("folds earlier runs from the same automation run group", async () => {
    const threadId = "thread-run-group-folding";
    const automationId = "f0000001-0000-4000-a000-000000000722";
    const runGroupId = "f0000001-0000-4000-a000-000000000723";
    const automationSnapshot = {
      id: automationId,
      title: "Daily check",
      description: "Daily check",
    };
    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Run group folding",
      chatMessages: [
        {
          id: "msg-run-group-user-1",
          role: "user",
          content: "Run the daily check",
          runId: "f0000001-0000-4000-a000-000000000724",
          runGroupId,
          automationId,
          automationSnapshot,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-run-group-assistant-1",
          role: "assistant",
          content: "First daily check result",
          runId: "f0000001-0000-4000-a000-000000000724",
          runGroupId,
          createdAt: "2026-06-09T10:00:01Z",
        },
        {
          id: "msg-run-group-usage-1",
          role: "assistant",
          content: null,
          runId: "f0000001-0000-4000-a000-000000000724",
          usage: {
            version: 1,
            totalCredits: 10,
            settledAt: "2026-06-09T10:00:02Z",
            breakdown: [
              {
                kind: "connector",
                credits: 10,
                providers: [{ provider: "github", credits: 10 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:00:02Z",
        },
        {
          id: "msg-run-group-user-2",
          role: "user",
          content: "Run the daily check",
          runId: "f0000001-0000-4000-a000-000000000725",
          runGroupId,
          automationId,
          automationSnapshot,
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-run-group-assistant-2",
          role: "assistant",
          content: "Second daily check result",
          runId: "f0000001-0000-4000-a000-000000000725",
          runGroupId,
          createdAt: "2026-06-09T10:01:01Z",
        },
        {
          id: "msg-run-group-usage-2",
          role: "assistant",
          content: null,
          runId: "f0000001-0000-4000-a000-000000000725",
          usage: {
            version: 1,
            totalCredits: 20,
            settledAt: "2026-06-09T10:01:02Z",
            breakdown: [
              {
                kind: "connector",
                credits: 20,
                providers: [{ provider: "github", credits: 20 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:01:02Z",
        },
        {
          id: "msg-run-group-user-3",
          role: "user",
          content: "Run the daily check",
          runId: "f0000001-0000-4000-a000-000000000726",
          runGroupId,
          automationId,
          automationSnapshot,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-run-group-assistant-3",
          role: "assistant",
          content: "Latest daily check result",
          runId: "f0000001-0000-4000-a000-000000000726",
          runGroupId,
          createdAt: "2026-06-09T10:02:01Z",
        },
        {
          id: "msg-run-group-usage-3",
          role: "assistant",
          content: null,
          runId: "f0000001-0000-4000-a000-000000000726",
          usage: {
            version: 1,
            totalCredits: 30,
            settledAt: "2026-06-09T10:02:02Z",
            breakdown: [
              {
                kind: "connector",
                credits: 30,
                providers: [{ provider: "github", credits: 30 }],
              },
            ],
          },
          createdAt: "2026-06-09T10:02:02Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Run group folding")).toBeInTheDocument();
      expect(screen.getByText("Latest daily check result")).toBeInTheDocument();
      const foldButton = buttonByLabel("Expand grouped run history");
      expect(
        within(foldButton).getByText("2 runs for Daily check"),
      ).toBeInTheDocument();
      expect(
        within(foldButton).getByText("2 runs for Daily check"),
      ).toHaveClass("truncate", "whitespace-nowrap");
      expect(
        screen.queryByText("First daily check result"),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Second daily check result"),
      ).not.toBeInTheDocument();
    });

    const credit = await screen.findByLabelText("Credit usage 60");
    expect(screen.queryByLabelText("Credit usage 30")).not.toBeInTheDocument();

    click(credit);

    await waitFor(() => {
      expect(screen.getAllByText("Github").length).toBeGreaterThanOrEqual(1);
      expect(screen.getAllByText("60").length).toBeGreaterThanOrEqual(1);
    });

    fireEvent.click(buttonByLabel("Expand grouped run history"));

    await waitFor(() => {
      expect(screen.getByText("First daily check result")).toBeInTheDocument();
      expect(screen.getByText("Second daily check result")).toBeInTheDocument();
    });
  });

  it("surfaces archived goal history in the latest assistant row", async () => {
    const threadId = "thread-goal-run-group-folding";
    const runGroupId = "f0000001-0000-4000-a000-00000000072b";
    const goalPrompt = "Keep the release moving";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Goal run group folding",
      chatMessages: [
        {
          id: "msg-goal-run-group-user-1",
          role: "user",
          content: goalPrompt,
          runId: "f0000001-0000-4000-a000-00000000072c",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-goal-run-group-assistant-1",
          role: "assistant",
          content: "First goal result",
          runId: "f0000001-0000-4000-a000-00000000072c",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-goal-run-group-user-2",
          role: "user",
          content: goalPrompt,
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-goal-run-group-assistant-2a",
          role: "assistant",
          content: "Checking the current goal state.",
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          isGoalRun: true,
          createdAt: "2026-06-09T10:02:10Z",
        },
        {
          id: "msg-goal-run-group-assistant-2b",
          role: "assistant",
          content: "Latest goal result",
          runId: "f0000001-0000-4000-a000-00000000072d",
          runGroupId,
          isGoalRun: true,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:02:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Latest goal result")).toBeInTheDocument();
      expect(screen.getByLabelText("Goal")).toBeInTheDocument();
      expect(screen.getByText(goalPrompt)).toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "3 mins for Keep the release moving",
      );
      expect(screen.queryByText("Worked for 30s")).not.toBeInTheDocument();
      expect(screen.queryByText("First goal result")).not.toBeInTheDocument();
    });

    const latestAssistantGroup = screen
      .getByText("Latest goal result")
      .closest('[data-role="assistant"]') as HTMLElement | null;
    expect(latestAssistantGroup).not.toBeNull();
    expect(
      within(latestAssistantGroup!).getByText(
        "3 mins for Keep the release moving",
      ),
    ).toBeInTheDocument();
    expectTextBefore(
      document.body,
      goalPrompt,
      "3 mins for Keep the release moving",
    );
    expectTextBefore(
      latestAssistantGroup!,
      "3 mins for Keep the release moving",
      "Latest goal result",
    );

    fireEvent.click(buttonByLabel("Expand grouped run history"));

    await waitFor(() => {
      expect(screen.getByText("First goal result")).toBeInTheDocument();
      expect(screen.getByText("Worked for 30s")).toBeInTheDocument();
    });
  });

  it("does not treat workflow run groups as goals", async () => {
    const threadId = "thread-workflow-run-group-folding";
    const runGroupId = "f0000001-0000-4000-a000-00000000073b";
    const workflowPrompt = "/daily-workflow";
    const workflowSnapshot = {
      name: "daily-workflow",
      displayName: "Daily workflow",
      description: "Daily workflow summary",
    };

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Workflow run group folding",
      chatMessages: [
        {
          id: "msg-workflow-run-group-user-1",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000073c",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-run-group-assistant-1",
          role: "assistant",
          content: "First workflow result",
          runId: "f0000001-0000-4000-a000-00000000073c",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
          createdAt: "2026-06-09T10:00:30Z",
        },
        {
          id: "msg-workflow-run-group-user-2",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000073d",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-workflow-run-group-assistant-2",
          role: "assistant",
          content: "Latest workflow result",
          runId: "f0000001-0000-4000-a000-00000000073d",
          runGroupId,
          triggerSource: "workflow-event",
          workflowSnapshot,
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:02:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(screen.getByText("Latest workflow result")).toBeInTheDocument();
      expect(screen.queryByLabelText("Goal")).not.toBeInTheDocument();
      expect(buttonByLabel("Expand grouped run history")).toHaveTextContent(
        "1 run for Daily workflow summary",
      );
      expect(
        screen.queryByText("First workflow result"),
      ).not.toBeInTheDocument();
    });
  });

  it("renders workflow trigger user messages with the workflow title and brief", async () => {
    const threadId = "thread-workflow-user-message-marker";
    const workflowPrompt = "/daily-workflow";

    mockChatLifecycle(context, {
      threadId,
      threadTitle: "Workflow user message marker",
      chatMessages: [
        {
          id: "msg-workflow-marker-user",
          role: "user",
          content: workflowPrompt,
          runId: "f0000001-0000-4000-a000-00000000083c",
          triggerSource: "workflow-event",
          workflowSnapshot: {
            id: "f0000001-0000-4000-a000-000000000831",
            agentId: "c0000000-0000-4000-a000-000000000001",
            name: "daily-workflow",
            displayName: "Daily workflow",
            description: "Daily workflow summary",
            triggerId: "f0000001-0000-4000-a000-000000000832",
            triggerBrief: "Gmail label applied",
          },
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-workflow-marker-assistant",
          role: "assistant",
          content: "Workflow result",
          runId: "f0000001-0000-4000-a000-00000000083c",
          triggerSource: "workflow-event",
          createdAt: "2026-06-09T10:00:30Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText("Workflow Daily workflow"),
      ).toBeInTheDocument();
      expect(screen.getByText("Gmail label applied")).toBeInTheDocument();
      expect(
        screen.queryByText("Daily workflow · Gmail label applied"),
      ).not.toBeInTheDocument();
      expect(screen.queryByText(workflowPrompt)).not.toBeInTheDocument();
    });
  });

  it("shows template labels on historical user messages", async () => {
    const threadId = "template-message-history";
    const presentationTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
    const videoTemplate = VIDEO_TEMPLATE_ITEMS[0]!;
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
    });

    await waitFor(() => {
      expect(
        screen.getByLabelText(`Message template ${presentationTemplate.title}`),
      ).toHaveTextContent("Presentation");
      expect(
        screen.getByLabelText(`Message template ${videoTemplate.title}`),
      ).toHaveTextContent("Video");
      expect(
        screen.getByLabelText(`Message template ${illustrationTemplate.title}`),
      ).toHaveTextContent("Illustration");
    });
  });

  it("shows historical template labels after picker rollout", async () => {
    const threadId = "template-message-history-gated";
    const presentationTemplate = PRESENTATION_TEMPLATE_PICKER_ITEMS[0]!;
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
    });

    await waitFor(() => {
      expect(screen.getByText("Create the business review deck")).toBeVisible();
      expect(
        screen.getByLabelText(`Message template ${presentationTemplate.title}`),
      ).toHaveTextContent("Presentation");
      expect(
        screen.getByLabelText(`Message template ${illustrationTemplate.title}`),
      ).toHaveTextContent("Illustration");
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

    const item = await readSingleRichClipboardWrite(clipboard);
    const plainText = await readClipboardItemText(item, "text/plain");
    expect(plainText).toBe(
      [
        "Review the launch assets",
        "",
        "Attachments:",
        `- chart.png: ${imageUrl}`,
        `- demo.mp4: ${videoUrl}`,
        `- briefing.mp3: ${audioUrl}`,
        `- notes.md: ${markdownUrl}`,
      ].join("\n"),
    );
    const html = await readClipboardItemText(item, "text/html");
    expect(html).toContain("data-vm0-chat-message");
    expect(html).toContain(`<a href="${imageUrl}"`);
    expect(html).not.toContain("<img");
    const payload = parseChatClipboardPayload(html);
    expect(payload.text).toBe("Review the launch assets");
    expect(payload.attachments).toHaveLength(4);
    expect(payload.attachments[0]).toStrictEqual({
      id: "attachment-chart",
      filename: "chart.png",
      url: imageUrl,
      contentType: "image/*",
      size: 0,
    });
  });

  it("copies text and links for a user message with image attachments from chat history", async () => {
    const clipboard = context.mocks.browser.clipboardWrite();
    const threadId = "image-attachment-copy";
    const messageText = "Review this image";
    const imageUrl = "https://cdn.vm7.io/artifacts/test/photo/photo.png";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-image-attachment-copy",
          role: "user",
          content: messageText,
          attachFiles: [
            {
              id: "attachment-photo",
              filename: "photo.png",
              contentType: "image/png",
              size: 2048,
              url: imageUrl,
            },
          ],
          createdAt: "2026-06-09T10:00:00Z",
        },
      ],
    });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(screen.getByText(messageText)).toBeInTheDocument();
      expect(screen.getByLabelText("Preview photo.png")).toBeInTheDocument();
    });

    click(screen.getByLabelText("Copy message"));

    const item = await readSingleRichClipboardWrite(clipboard);
    const plainText = await readClipboardItemText(item, "text/plain");
    expect(plainText).toBe(
      [messageText, "", "Attachments:", `- photo.png: ${imageUrl}`].join("\n"),
    );
    const html = await readClipboardItemText(item, "text/html");
    expect(html).toContain("data-vm0-chat-message");
    expect(html).toContain(`<a href="${imageUrl}"`);
    expect(html).not.toContain("<img");
    expect(parseChatClipboardPayload(html)).toStrictEqual({
      text: messageText,
      attachments: [
        {
          id: "attachment-photo",
          filename: "photo.png",
          url: imageUrl,
          contentType: "image/png",
          size: 2048,
        },
      ],
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

  it("sends a recommended follow-up from the latest assistant reply", async () => {
    const assistantReply = "I can turn this into a launch package.";
    const followupPrompt = "Create a presentation outline";
    const sentMessages: {
      prompt?: string;
      revokesMessageId?: string;
    }[] = [];

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
      onRunCreate: (body) => {
        sentMessages.push(body);
      },
    });

    detachedSetupPage({
      context,
      path: `/chats/${FOLLOWUP_THREAD_ID}`,
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
    expect(sentMessages).toHaveLength(1);
    expect(sentMessages[0]).toMatchObject({ prompt: followupPrompt });
    expect(sentMessages[0]?.revokesMessageId).toBeUndefined();
  });

  it("hides recommended follow-ups after a newer assistant reply", async () => {
    const firstAssistantReply = "I can turn this into a launch package.";
    const newerAssistantReply = "Here is the newer launch package.";
    const followupPrompt = "Create a presentation outline";

    mockChatLifecycle(context, {
      threadId: FOLLOWUP_THREAD_ID,
      threadTitle: "Launch package",
      chatMessages: [
        {
          id: "msg-followup-old-user",
          role: "user",
          content: "Package this launch plan",
          runId: "run-followup-old",
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-followup-old-assistant",
          role: "assistant",
          content: firstAssistantReply,
          runId: "run-followup-old",
          createdAt: "2026-06-09T10:01:00Z",
        },
        {
          id: "msg-followup-old-completed",
          role: "assistant",
          content: null,
          runId: "run-followup-old",
          runLifecycleEvent: "completed",
          recommendedFollowups: [
            {
              prompt: followupPrompt,
              kind: "generate",
              generationType: "presentation",
            },
          ],
          createdAt: "2026-06-09T10:01:01Z",
        },
        {
          id: "msg-followup-new-user",
          role: "user",
          content: followupPrompt,
          runId: "run-followup-new",
          createdAt: "2026-06-09T10:02:00Z",
        },
        {
          id: "msg-followup-new-assistant",
          role: "assistant",
          content: newerAssistantReply,
          runId: "run-followup-new",
          createdAt: "2026-06-09T10:03:00Z",
        },
        {
          id: "msg-followup-new-completed",
          role: "assistant",
          content: null,
          runId: "run-followup-new",
          runLifecycleEvent: "completed",
          createdAt: "2026-06-09T10:03:01Z",
        },
      ],
    });

    detachedSetupPage({
      context,
      path: `/chats/${FOLLOWUP_THREAD_ID}`,
    });

    await waitFor(() => {
      expect(screen.getByText(firstAssistantReply)).toBeInTheDocument();
      expect(screen.getByText(newerAssistantReply)).toBeInTheDocument();
      expect(queryButtonByText(followupPrompt)).not.toBeInTheDocument();
    });
  });

  it("shows online computers in the chat composer", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-selection";
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      computerUseHostId: "22222222-2222-4222-8222-222222222222",
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: null,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        running: false,
      },
    ]);
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: "11111111-1111-4111-8111-111111111111",
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
          {
            id: "22222222-2222-4222-8222-222222222222",
            displayName: "Office Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
            status: "online",
            lastSeenAt: "2026-06-10T12:01:00Z",
            createdAt: "2026-06-10T11:01:00Z",
          },
          {
            id: "33333333-3333-4333-8333-333333333333",
            displayName: "Offline Desktop",
            appVersion: "1.0.0",
            osVersion: "Windows 11",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
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
    });

    await user.click(await screen.findByLabelText("Connectors"));

    await waitFor(() => {
      expect(screen.getByText("Studio Mac")).toBeInTheDocument();
      expect(screen.getByText("Office Mac")).toBeInTheDocument();
      expect(screen.queryByText("Offline Desktop")).not.toBeInTheDocument();
      expect(screen.getByText("Connect my computer")).toBeInTheDocument();
      expect(
        screen.getByRole("switch", { name: "Connect Studio Mac" }),
      ).toHaveAttribute("aria-checked", "false");
      expect(
        screen.getByRole("switch", { name: "Disconnect Office Mac" }),
      ).toHaveAttribute("aria-checked", "true");
    });

    const hostsGroup = screen.getByRole("group", {
      name: "Computer Use hosts",
    });
    expect(
      within(hostsGroup)
        .getAllByRole("switch")
        .map((item) => {
          return item.getAttribute("aria-label");
        }),
    ).toStrictEqual(["Connect Studio Mac", "Disconnect Office Mac"]);
  });

  it("opens the Computer Use download dialog from the chat composer", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-download";
    mockChatLifecycle(context, { threadId });
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, { hosts: [] });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await user.click(await screen.findByLabelText("Connectors"));
    await user.click(await screen.findByText("Connect my computer"));

    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Let Zero use your computer")).toBeInTheDocument();
    expect(
      screen.getByText(
        "So Zero can work in your browser and apps for you, even ones with no connector like LinkedIn or Reddit.",
      ),
    ).toBeInTheDocument();
    expect(linkByText("Download for macOS")).toHaveAttribute(
      "href",
      expect.stringContaining(
        "/api/zero/desktop/updates/stable/darwin/arm64/dmg",
      ),
    );
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
            permissions: computerUsePermissions(),
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
    });

    await user.click(await screen.findByLabelText("Connectors"));
    expect(
      screen.getByRole("switch", { name: "Connect Studio Mac" }),
    ).toHaveAttribute("aria-checked", "false");

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Open the app on my computer");

    await waitFor(() => {
      expect(
        screen.getByText("Open the app on my computer"),
      ).toBeInTheDocument();
      expect(sentComputerUseHostId).toBeUndefined();
    });
  });

  it("refreshes computers when the computer-use hosts Ably event arrives", async () => {
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
            permissions: computerUsePermissions(),
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
    });

    await waitFor(() => {
      expect(
        context.mocks.ably.hasSubscription("computerUseHostsChanged"),
      ).toBeTruthy();
    });

    await user.click(await screen.findByLabelText("Connectors"));

    await waitFor(() => {
      expect(screen.getByText("Studio Mac")).toBeInTheDocument();
    });

    const requestCountAfterInitialLoad = requestCount;
    hostOnline = false;

    context.mocks.ably.trigger("computerUseHostsChanged");

    await waitFor(() => {
      expect(requestCount).toBeGreaterThan(requestCountAfterInitialLoad);
      expect(screen.queryByText("Studio Mac")).not.toBeInTheDocument();
    });
  });

  it("persists the selected Computer Use host before sending", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-send";
    const hostId = "33333333-3333-4333-8333-333333333333";
    let sendCount = 0;
    let sentComputerUseHostId: string | null | undefined;
    let updatedComputerUseHostId: string | null | undefined;
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      onComputerUseHostUpdate: (body) => {
        updatedComputerUseHostId = body.computerUseHostId;
      },
      onRunCreate: (body) => {
        sendCount += 1;
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: null,
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        running: false,
      },
    ]);
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
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
    });

    await user.click(await screen.findByLabelText("Connectors"));
    const hostsGroup = await screen.findByRole("group", {
      name: "Computer Use hosts",
    });
    await user.click(within(hostsGroup).getByText("Studio Mac"));
    await waitFor(() => {
      expect(updatedComputerUseHostId).toBe(hostId);
    });

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await fill(textarea, "Open the app on my computer");
    const sendButton = screen.getByLabelText("Send");
    await waitFor(() => {
      expect(sendButton).toBeEnabled();
    });
    await user.click(sendButton);

    await waitFor(() => {
      expect(sendCount).toBe(1);
      expect(
        screen.getByText("Open the app on my computer"),
      ).toBeInTheDocument();
      expect(sentComputerUseHostId).toBeUndefined();
    });
  });

  it("shows and clears a saved Computer Use host selection", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-saved-selection";
    const hostId = "11111111-1111-4111-8111-111111111111";
    let sentComputerUseHostId: string | null | undefined;
    let updatedComputerUseHostId: string | null | undefined;
    const lifecycle = mockChatLifecycle(context, {
      threadId,
      threadTitle: "Computer Use",
      computerUseHostId: hostId,
      onComputerUseHostUpdate: (body) => {
        updatedComputerUseHostId = body.computerUseHostId;
      },
      onRunCreate: (body) => {
        sentComputerUseHostId = body.computerUseHostId;
      },
    });
    lifecycle.setThreadList([
      {
        id: threadId,
        title: "Computer Use",
        agent: { id: AGENT_ID, avatarUrl: null },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        running: false,
      },
    ]);
    context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
      return respond(200, {
        hosts: [
          {
            id: hostId,
            displayName: "Studio Mac",
            appVersion: "1.0.0",
            osVersion: "macOS 15.0",
            supportedCapabilities: ["app.open"],
            permissions: computerUsePermissions(),
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
    });

    await user.click(await screen.findByLabelText("Connectors"));

    const selectedComputer = await screen.findByRole("switch", {
      name: "Disconnect Studio Mac",
    });
    expect(selectedComputer).toHaveAttribute("aria-checked", "true");
    await user.click(selectedComputer);
    await waitFor(() => {
      expect(updatedComputerUseHostId).toBeNull();
    });

    const textarea = (await screen.findByPlaceholderText(
      PLACEHOLDER,
    )) as HTMLTextAreaElement;
    await sendMessageInUI(user, textarea, "Do not use my computer");

    await waitFor(() => {
      expect(screen.getByText("Do not use my computer")).toBeInTheDocument();
      expect(sentComputerUseHostId).toBeUndefined();
    });
  });

  it("shows a saved offline Computer Use host selection", async () => {
    const user = userEvent.setup({ delay: null });
    const threadId = "computer-use-saved-offline-selection";
    const hostId = "22222222-2222-4222-8222-222222222222";
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
            permissions: computerUsePermissions(),
            status: "offline",
            lastSeenAt: "2026-06-10T12:00:00Z",
            createdAt: "2026-06-10T11:00:00Z",
          },
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
    });

    await user.click(await screen.findByLabelText("Connectors"));

    const hostName = await screen.findByText("Studio Mac");
    expect(hostName).toBeInTheDocument();
    expect(screen.getByText("Offline")).toBeInTheDocument();
    expect(
      screen.getByRole("switch", { name: "Disconnect Studio Mac" }),
    ).toHaveAttribute("aria-checked", "true");
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
    });

    await user.click(await screen.findByLabelText("Connectors"));

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

  it("shows Pro upgrade guidance when built-in video requires Pro", async () => {
    const threadId = "failed-guidance-video-pro";
    mockFailedAssistantThread({ threadId, error: "pro_required" });
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

  it("shows Pro upgrade guidance for limited-free-1 even with credits", async () => {
    const threadId = "failed-guidance-limited-free";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });
    context.mocks.data.org({
      id: "org_1",
      slug: "test-org",
      name: "Test Org",
      role: "admin",
    });
    context.mocks.api(zeroBillingStatusContract.get, ({ respond }) => {
      return respond(200, {
        tier: "limited-free-1",
        credits: 1500,
        onboardingPaymentPending: false,
        subscriptionStatus: null,
        currentPeriodEnd: null,
        cancelAtPeriodEnd: false,
        scheduledChange: null,
        hasSubscription: false,
        autoRecharge: { enabled: false, threshold: null, amount: null },
        creditExpiry: {
          expiringNextCycle: 0,
          nextExpiryDate: null,
        },
        creditBreakdown: [],
        creditGrants: [],
        concurrencyLimit: 1,
        concurrencySubscriptions: [],
      });
    });
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
      expect(screen.queryByText("Credits available")).toBeNull();
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
        concurrencyLimit: 0,
        concurrencySubscriptions: [],
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
        concurrencyLimit: 0,
        concurrencySubscriptions: [],
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
            running: true,
          },
          {
            id: "thread-completed",
            title: "Completed thread",
            agent: { id: AGENT_ID, avatarUrl: null },
            createdAt: "2026-03-10T00:01:00Z",
            updatedAt: "2026-03-10T00:01:00Z",
            running: false,
          },
        ],
        hasMore: false,
        nextCursor: null,
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
        automationId: null,
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

describe("initial thinking indicator", () => {
  it("renders the latest run thinking marker inside the thinking indicator", async () => {
    const threadId = "thread-initial-thinking";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-thinking-user",
          role: "user",
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-marker",
          role: "assistant",
          content: null,
          thinking: "Reviewing your request",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatInitialThinkingIndicator]: true,
      },
    });

    await waitFor(() => {
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
    });
    const label = await screen.findByLabelText("Reviewing your request");
    expect(label.closest("[data-thinking-indicator]")).not.toBeNull();
  });

  it("keeps the thinking marker visible while later messages are queued", async () => {
    const threadId = "thread-initial-thinking-with-queue";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-thinking-queued-user",
          role: "user",
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-queued-marker",
          role: "assistant",
          content: null,
          thinking: "Reviewing your request",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          id: "msg-thinking-queued-followup",
          role: "user",
          content: "Also include owners",
          runId: undefined,
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatInitialThinkingIndicator]: true,
      },
    });

    const label = await screen.findByLabelText("Reviewing your request");
    expect(label.closest("[data-thinking-indicator]")).not.toBeNull();
    await waitFor(() => {
      expect(screen.getByLabelText("Queued message")).toHaveTextContent(
        "Also include owners",
      );
    });
  });

  it("hides the thinking marker when the same run has assistant text", async () => {
    const threadId = "thread-initial-thinking-answer";
    mockChatLifecycle(context, {
      threadId,
      chatMessages: [
        {
          id: "msg-thinking-answer-user",
          role: "user",
          content: "Draft a launch checklist",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:00Z",
        },
        {
          id: "msg-thinking-answer-marker",
          role: "assistant",
          content: null,
          thinking: "Reviewing your request",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:01Z",
        },
        {
          id: "msg-thinking-answer",
          role: "assistant",
          content: "Here is the checklist.",
          runId: "run-active",
          createdAt: "2026-03-10T00:00:02Z",
        },
      ],
      activeRunIds: ["run-active"],
    });

    detachedSetupPage({
      context,
      path: `/chats/${threadId}`,
      featureSwitches: {
        [FeatureSwitchKey.ChatInitialThinkingIndicator]: true,
      },
    });

    await screen.findByText("Here is the checklist.");
    expect(
      screen.queryByText("Reviewing your request"),
    ).not.toBeInTheDocument();
  });
});
