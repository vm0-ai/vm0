import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadArtifactsContract,
  chatThreadGithubPrsContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
import { zeroBillingStatusContract } from "@vm0/api-contracts/contracts/zero-billing";
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
        status: "running",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
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
  ]);
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
        status: "failed",
        error,
        runLifecycleEvent: "failed",
        createdAt: "2026-06-09T10:00:01Z",
      },
    ],
  });
}

function installVoiceInputMocks(): void {
  const originalMediaDevices = navigator.mediaDevices;
  const mediaRecorderGlobal = globalThis as typeof globalThis & {
    MediaRecorder?: typeof MediaRecorder;
  };
  const originalMediaRecorder = mediaRecorderGlobal.MediaRecorder;
  const stream = {
    getTracks: () => {
      return [
        {
          stop: () => {
            return undefined;
          },
        },
      ];
    },
  } as unknown as MediaStream;

  type RecorderDataEvent = Event & { data: Blob };

  class TestMediaRecorder extends EventTarget {
    static isTypeSupported(type: string): boolean {
      return type === "audio/webm";
    }

    mimeType: string;
    ondataavailable: ((event: RecorderDataEvent) => void) | null = null;
    state: RecordingState = "inactive";

    constructor(_stream: MediaStream, options?: MediaRecorderOptions) {
      super();
      this.mimeType = options?.mimeType ?? "audio/webm";
    }

    start(): void {
      this.state = "recording";
    }

    stop(): void {
      if (this.state === "inactive") {
        return;
      }
      this.state = "inactive";
      const event = new Event("dataavailable") as RecorderDataEvent;
      Object.defineProperty(event, "data", {
        value: new Blob(["voice"], { type: this.mimeType }),
      });
      this.ondataavailable?.(event);
      this.dispatchEvent(new Event("stop"));
    }
  }

  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      enumerateDevices: () => {
        return Promise.resolve([] as MediaDeviceInfo[]);
      },
      getUserMedia: () => {
        return Promise.resolve(stream);
      },
    },
  });
  Object.defineProperty(mediaRecorderGlobal, "MediaRecorder", {
    configurable: true,
    value: TestMediaRecorder,
  });
  context.signal.addEventListener(
    "abort",
    () => {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: originalMediaDevices,
      });
      Object.defineProperty(mediaRecorderGlobal, "MediaRecorder", {
        configurable: true,
        value: originalMediaRecorder,
      });
    },
    { once: true },
  );
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
        latestSessionId: null,
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

    click(buttonByText("Load history"));
    await waitFor(() => {
      expect(screen.getByText(olderReply)).toBeInTheDocument();
    });

    setScrollMetrics(scrollContainer, {
      scrollHeight: 1500,
      clientHeight: 300,
    });
    fireEvent.keyDown(threadRegion, { key: "ArrowDown", ctrlKey: true });
    expect(scrollContainer.scrollTop).toBe(1500);
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
          status: "completed",
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
          status: "completed",
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
          status: "completed",
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
          runId: undefined,
          createdAt: "2026-06-09T10:00:00Z",
        },
        {
          id: "msg-followup-assistant",
          role: "assistant",
          content: assistantReply,
          runId: undefined,
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
          createdAt: "2026-06-09T10:01:00Z",
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
      expect(screen.queryByText("Offline Desktop")).not.toBeInTheDocument();
      expect(screen.getByText("Connect my computer")).toBeInTheDocument();
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
    installVoiceInputMocks();
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

  it("shows billing recovery guidance when credits are depleted", async () => {
    const threadId = "failed-guidance-credits";
    mockFailedAssistantThread({ threadId, error: "insufficient_credits" });

    detachedSetupPage({ context, path: `/chats/${threadId}` });

    await waitFor(() => {
      expect(
        screen.getByText("Upgrade to Pro to run Zero"),
      ).toBeInTheDocument();
      expect(buttonByText("Upgrade to Pro")).toBeInTheDocument();
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
                status: "running",
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
        latestSessionId: null,
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
