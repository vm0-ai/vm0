import { act, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import {
  chatThreadByIdContract,
  chatThreadGithubPrsContract,
  chatThreadMarkReadContract,
  chatThreadMessagesContract,
  chatThreadsContract,
  type PagedChatMessage,
} from "@vm0/api-contracts/contracts/chat-threads";
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

describe("chat lifecycle", () => {
  it("completes a run, renders markdown, and returns the composer to send mode", async () => {
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

  it("queues, recalls, and replays messages while an optimistic new thread settles", async () => {
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

    await act(async () => {
      sendGate.resolve();
      await Promise.resolve();
    });

    await expectQueuedMessages([
      "Second queued follow-up",
      "Replayed follow-up",
    ]);
    expect(screen.getByText("First new-thread message")).toBeInTheDocument();
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

  it("opens a linked schedule from the chat header", async () => {
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

    click(screen.getByText("Launch review"));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: "Launch review" }),
      ).toBeInTheDocument();
    });
  });

  it("opens GitHub PR tracking and queues a conflict fix command from the dock", async () => {
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
        ],
      });
    });

    detachedSetupPage({
      context,
      path: `/chats/${GITHUB_PR_THREAD_ID}`,
      featureSwitches: { [FeatureSwitchKey.ChatGithubPrTracking]: true },
    });

    click(await screen.findByLabelText("Open GitHub PR tracking"));

    await waitFor(() => {
      expect(screen.getByLabelText("GitHub PR tracking")).toBeInTheDocument();
      expect(screen.getByText("vm0-ai/vm0 #123")).toBeInTheDocument();
      expect(screen.getByText("Fix flaky platform tests")).toBeInTheDocument();
      expect(screen.getByText("Conflicts")).toBeInTheDocument();
      expect(screen.getByText("unit tests")).toBeInTheDocument();
      expect(screen.getByText("deploy preview")).toBeInTheDocument();
    });

    click(await screen.findByText("Fix conflict"));

    await waitFor(() => {
      expect(
        screen.getByText("fix pr 123 conflict & push"),
      ).toBeInTheDocument();
    });

    click(screen.getByLabelText("Close GitHub PR tracking"));

    await waitFor(() => {
      expect(
        screen.queryByLabelText("GitHub PR tracking"),
      ).not.toBeInTheDocument();
    });
  });

  it("turns selected assistant text into an inline feedback follow-up", async () => {
    const assistantReply = "The rollout dates are unclear in this summary.";

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

    selectTextForInlineFeedback(await screen.findByText(assistantReply));

    await waitFor(() => {
      expect(screen.getByText("Provide feedback")).toBeInTheDocument();
    });

    click(screen.getByText("Provide feedback"));

    const feedbackComment = await screen.findByPlaceholderText(
      "What should change about this?",
    );
    await fill(feedbackComment, "Mention the dates before the risk summary.");
    click(screen.getByText("Send feedback"));

    await waitFor(() => {
      expect(
        screen.getByText("Feedback on this part of your reply:"),
      ).toBeInTheDocument();
      expect(
        screen.getByText("Mention the dates before the risk summary."),
      ).toBeInTheDocument();
    });

    expect(
      screen.queryByPlaceholderText("What should change about this?"),
    ).not.toBeInTheDocument();
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
    });

    click(buttonByText(followupPrompt));

    await waitFor(() => {
      expect(queryButtonByText(followupPrompt)).not.toBeInTheDocument();
      expect(screen.getByText(followupPrompt)).toBeInTheDocument();
      expect(screen.getByLabelText("Stop")).toBeInTheDocument();
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
