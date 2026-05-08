import userEvent from "@testing-library/user-event";
import { server } from "../../../mocks/server.ts";
import {
  createChatMessage,
  createChatRun,
  updateChatRun,
} from "../../../mocks/mock-helpers.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";
import { mockApi } from "../../../mocks/msw-contract.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadMessagesContract,
  chatMessagesContract,
  chatThreadPendingMessageAppendContract,
  chatThreadPendingMessageRecallContract,
  type PendingMessage,
  type PersistedAttachment,
} from "@vm0/api-contracts/contracts/chat-threads";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import {
  zeroRunAgentEventsContract,
  zeroRunsCancelContract,
  zeroRunsByIdContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import type { RunStatus } from "@vm0/api-contracts/contracts/runs";

import { fill } from "../../../__tests__/page-helper.ts";
import { setMockTeam } from "../../../mocks/handlers/api-agents.ts";

export const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
export const SUB_AGENT_ID = "a1111111-0000-4000-a000-000000000001";

export function mockSubagentThread(threadId: string) {
  setMockTeam([
    {
      id: DEFAULT_AGENT_ID,
      displayName: null,
      description: null,
      sound: null,
      avatarUrl: null,
      headVersionId: "version_1",
      updatedAt: "2024-01-01T00:00:00Z",
    },
    {
      id: SUB_AGENT_ID,
      displayName: "Assistant",
      description: null,
      sound: null,
      avatarUrl: "https://example.com/avatar.png",
      headVersionId: "version_2",
      updatedAt: "2024-01-01T00:00:00Z",
    },
  ]);
  server.use(
    mockApi(zeroTeamContract.list, ({ respond }) => {
      return respond(200, [
        {
          id: DEFAULT_AGENT_ID,
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          headVersionId: "version_1",
          updatedAt: "2024-01-01T00:00:00Z",
        },
        {
          id: SUB_AGENT_ID,
          displayName: "Assistant",
          description: null,
          sound: null,
          avatarUrl: "https://example.com/avatar.png",
          headVersionId: "version_2",
          updatedAt: "2024-01-01T00:00:00Z",
        },
      ]);
    }),
    mockApi(chatThreadMessagesContract.list, ({ respond }) => {
      return respond(200, { messages: [] });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      return respond(200, {
        id: threadId,
        title: null,
        agentId: SUB_AGENT_ID,
        chatMessages: [],
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        draftContent: null,
        draftAttachments: null,
      });
    }),
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads: [] });
    }),
    mockApi(zeroAgentsByIdContract.get, ({ params, respond }) => {
      const agents: Record<
        string,
        {
          agentId: string;
          displayName: string | null;
          ownerId: string;
          description: null;
          sound: null;
          avatarUrl: string | null;
          permissionPolicies: null;
          customSkills: string[];
        }
      > = {
        [DEFAULT_AGENT_ID]: {
          agentId: DEFAULT_AGENT_ID,
          ownerId: "test-user",
          displayName: null,
          description: null,
          sound: null,
          avatarUrl: null,
          permissionPolicies: null,
          customSkills: [],
        },
        [SUB_AGENT_ID]: {
          agentId: SUB_AGENT_ID,
          ownerId: "test-user",
          displayName: "Assistant",
          description: null,
          sound: null,
          avatarUrl: "https://example.com/avatar.png",
          permissionPolicies: null,
          customSkills: [],
        },
      };
      const agent = agents[params.id];
      if (!agent) {
        return respond(404, {
          error: { message: "Not found", code: "NOT_FOUND" },
        });
      }
      return respond(200, agent);
    }),
  );
}

export async function sendMessageInUI(
  user: ReturnType<typeof userEvent.setup>,
  textarea: HTMLTextAreaElement,
  text: string,
): Promise<void> {
  await fill(textarea, text);
  await user.keyboard("{Enter}");
}

interface ThreadListItem {
  id: string;
  title: string | null;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  isRead: boolean;
  isArchived: boolean;
  running: boolean;
}

interface MockLifecycleControl {
  setRunStatus: (status: RunStatus) => void;
  setQueuePosition: (n: number) => void;
  setEvents: (e: AgentEvent[]) => void;
  setThreadList: (list: ThreadListItem[]) => void;
  completeRun: (content?: string) => void;
  failRun: (error: string) => void;
  cancelRun: () => void;
  /**
   * Drop the queued pending message — simulates the server consuming the
   * queue when the previous run finishes. The next chatThreadByIdContract.get
   * will respond with `pendingMessage: null`.
   */
  clearPendingMessage: () => void;
}

export function mockChatLifecycle(options?: {
  threadId?: string;
  historyMessages?: {
    role: "user" | "assistant";
    content: string | null;
    runId?: string;
    error?: string;
    status?: string;
    createdAt: string;
    attachFiles?: {
      id: string;
      filename: string;
      contentType: string;
      size: number;
      url: string;
    }[];
  }[];
  chatMessages?: {
    role: "user" | "assistant";
    content: string | null;
    runId?: string;
    error?: string;
    status?: string;
    createdAt: string;
    attachFiles?: {
      id: string;
      filename: string;
      contentType: string;
      size: number;
      url: string;
    }[];
  }[];
  threadTitle?: string | null;
  pendingMessage?: PendingMessage | null;
  onPendingMessageAppend?: (body: {
    content?: string;
    attachments?: PersistedAttachment[];
    clientMessageId?: string;
  }) => void;
  onPendingMessageRecall?: () => void;
  /**
   * Promise the recall handler awaits before responding. Lets a test observe
   * the in-flight loading state before letting the request complete.
   */
  recallGate?: Promise<void>;
  /**
   * Promise the append handler awaits before responding. Lets a test observe
   * the optimistic pending state (disabled Recall button) before the server
   * round-trip completes.
   */
  appendGate?: Promise<void>;
  onRunCreate?: () => void;
}): MockLifecycleControl {
  let threadId = options?.threadId ?? "thread-test-1";
  const historyMessages = options?.historyMessages ?? [];
  const chatMessages = options?.chatMessages ?? [];

  let runStatus: RunStatus = "running";
  let runError: string | null = null;
  let events: AgentEvent[] = [];
  let queuePosition = 0;
  let resultContent = "";
  let threadList: ThreadListItem[] = [];
  let runPrompt: string | null = null;
  let runAssociated = false;
  let threadTitle: string | null = options?.threadTitle ?? null;
  let pendingMessage: PendingMessage | null = options?.pendingMessage ?? null;
  // Version counter: bumped whenever the run reaches a terminal state so
  // subsequent polls discover a "new" assistant message row (simulating the
  // real server inserting event-backed rows on run completion).
  let assistantVersion = 0;
  let lastDeliveredVersion = -1;

  server.use(
    // Paged messages endpoint — cursor-aware, version-aware mock.
    mockApi(chatThreadMessagesContract.list, ({ query, respond }) => {
      const sinceId = query.sinceId;
      const beforeId = query.beforeId;

      const assistantId = `msg-assistant-run-v${assistantVersion}`;

      const historicalMessages = historyMessages.map((message, i) => {
        return {
          id: `msg-history-${i}`,
          ...message,
        };
      });

      const pagedMessages: {
        id: string;
        role: "user" | "assistant";
        content: string | null;
        runId?: string;
        error?: string;
        status?: string;
        createdAt: string;
        attachFiles?: {
          id: string;
          filename: string;
          contentType: string;
          size: number;
          url: string;
        }[];
      }[] = [];

      for (const message of historicalMessages) {
        pagedMessages.push(message);
      }

      // Seed with pre-existing chatMessages (e.g. history on resume)
      for (let i = 0; i < chatMessages.length; i++) {
        pagedMessages.push({
          id: `msg-seed-${i}`,
          ...chatMessages[i]!,
        });
      }

      // After a run is associated, append user + assistant messages
      if (runAssociated) {
        pagedMessages.push({
          id: "msg-user-sent",
          role: "user",
          content: runPrompt ?? "Hello",
          createdAt: "2026-03-10T00:00:01Z",
        });
        pagedMessages.push({
          id: assistantId,
          role: "assistant",
          content: resultContent || null,
          runId: "run-test-1",
          error: runError ?? undefined,
          status: runStatus,
          createdAt: "2026-03-10T00:00:02Z",
        });
      }

      if (beforeId) {
        const beforeIndex = pagedMessages.findIndex((message) => {
          return message.id === beforeId;
        });
        if (beforeIndex <= 0) {
          return respond(200, { messages: [], hasHistoryBefore: false });
        }
        const olderMessages = pagedMessages.slice(
          Math.max(0, beforeIndex - 50),
          beforeIndex,
        );
        return respond(200, {
          messages: olderMessages,
          hasHistoryBefore: beforeIndex - olderMessages.length > 0,
        });
      }

      if (sinceId) {
        // If the assistant version bumped since the client's cursor, return
        // the updated assistant message as a "new" row. Otherwise return
        // empty to avoid duplicate keys.
        if (assistantVersion > lastDeliveredVersion && runAssociated) {
          lastDeliveredVersion = assistantVersion;
          const lastMsg = pagedMessages[pagedMessages.length - 1]!;
          return respond(200, {
            messages: [lastMsg],
          });
        }
        return respond(200, { messages: [] });
      }

      lastDeliveredVersion = assistantVersion;
      return respond(200, {
        messages: pagedMessages.slice(historyMessages.length),
        hasHistoryBefore: historyMessages.length > 0,
      });
    }),
    mockApi(chatThreadByIdContract.get, ({ respond }) => {
      const terminal = new Set(["completed", "failed", "cancelled", "timeout"]);
      const seedActiveRunIds = chatMessages
        .filter((m): m is typeof m & { runId: string; status: string } => {
          return (
            m.runId !== undefined &&
            m.status !== undefined &&
            !terminal.has(m.status)
          );
        })
        .map((m) => {
          return m.runId;
        });
      const lifecycleActiveRunIds =
        runAssociated && !terminal.has(runStatus) ? ["run-test-1"] : [];
      const activeRunIds = [...seedActiveRunIds, ...lifecycleActiveRunIds];
      return respond(200, {
        id: threadId,
        title: threadTitle,
        agentId: "c0000000-0000-4000-a000-000000000001",
        chatMessages: [],
        latestSessionId: null,
        activeRunIds,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        draftContent: null,
        draftAttachments: null,
        pendingMessage,
      });
    }),
    mockApi(
      chatThreadPendingMessageAppendContract.append,
      async ({ body, respond }) => {
        options?.onPendingMessageAppend?.(body);
        if (options?.appendGate) {
          await options.appendGate;
        }
        const now = new Date().toISOString();
        const nextContent =
          body.content === undefined
            ? (pendingMessage?.content ?? null)
            : pendingMessage?.content
              ? `${pendingMessage.content}\n${body.content}`
              : body.content;
        const nextAttachments = [
          ...(pendingMessage?.attachments ?? []),
          ...(body.attachments ?? []),
        ];
        pendingMessage = {
          content: nextContent,
          attachments: nextAttachments.length > 0 ? nextAttachments : null,
          createdAt: pendingMessage?.createdAt ?? now,
          updatedAt: now,
          clientMessageId:
            pendingMessage?.clientMessageId ?? body.clientMessageId ?? null,
        };
        return respond(200, { pendingMessage });
      },
    ),
    mockApi(
      chatThreadPendingMessageRecallContract.recall,
      async ({ respond }) => {
        // Fire the callback when the request arrives, before any gating —
        // tests use this to assert that recall reached the backend even
        // when the response is intentionally held open.
        options?.onPendingMessageRecall?.();
        if (options?.recallGate) {
          await options.recallGate;
        }
        if (!pendingMessage) {
          return respond(404, {
            error: { message: "Pending message not found", code: "NOT_FOUND" },
          });
        }
        const draftContent = pendingMessage.content;
        const draftAttachments = pendingMessage.attachments;
        pendingMessage = null;
        return respond(200, {
          draftContent,
          draftAttachments,
          pendingMessage: null,
        });
      },
    ),
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, { threads: threadList });
    }),
    mockApi(chatThreadsContract.create, ({ body, respond }) => {
      threadId = body.clientThreadId ?? threadId;
      return respond(201, {
        id: threadId,
        title: null,
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
    // Unified chat message endpoint (creates thread + run + association)
    mockApi(chatMessagesContract.send, ({ body, respond }) => {
      threadId = body.clientThreadId ?? threadId;
      if (body.prompt) {
        runPrompt = body.prompt;
      }
      options?.onRunCreate?.();
      runAssociated = true;
      createChatRun(threadId);
      createChatMessage(threadId);
      return respond(201, {
        runId: "run-test-1",
        threadId,
        status: "pending",
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(logsByIdContract.getById, ({ respond }) => {
      return respond(200, {
        id: "a0000000-0000-4000-a000-000000000001",
        sessionId: "session-1",
        agentId: "zero",
        displayName: null,
        framework: "claude-code",
        modelProvider: null,
        selectedModel: null,
        triggerSource: "web",
        triggerAgentName: null,
        scheduleId: null,
        status: runStatus,
        prompt: "Hello",
        appendSystemPrompt: null,
        error: runError,
        createdAt: "2026-03-10T00:00:00Z",
        startedAt: "2026-03-10T00:00:01Z",
        completedAt: null,
        artifact: { name: null, version: null },
      });
    }),
    mockApi(zeroRunAgentEventsContract.getAgentEvents, ({ respond }) => {
      return respond(200, {
        events,
        hasMore: false,
        framework: "claude-code",
      });
    }),
    mockApi(zeroRunsCancelContract.cancel, ({ respond }) => {
      return respond(200, {
        id: "a0000000-0000-4000-a000-000000000001",
        status: "cancelled",
        message: "Run cancelled",
      });
    }),
    mockApi(zeroRunsByIdContract.getById, ({ respond }) => {
      return respond(200, {
        runId: "a0000000-0000-4000-a000-000000000001",
        agentComposeVersionId: null,
        status: runStatus,
        prompt: runPrompt ?? "Hello",
        appendSystemPrompt: null,
        result: { agentSessionId: "session-1", output: resultContent },
        createdAt: "2026-03-10T00:00:00Z",
      });
    }),
    mockApi(zeroQueuePositionContract.getPosition, ({ respond }) => {
      return respond(200, { position: queuePosition, total: 0 });
    }),
  );

  return {
    setRunStatus: (s) => {
      runStatus = s;
    },
    setQueuePosition: (n) => {
      queuePosition = n;
    },
    setEvents: (e) => {
      events = e;
    },
    setThreadList: (list) => {
      threadList = list;
    },
    completeRun: (content?: string) => {
      runStatus = "completed";
      resultContent = content ?? "";
      threadTitle = threadTitle ?? runPrompt;
      assistantVersion++;
      if (content) {
        events = [
          ...events,
          {
            sequenceNumber: events.length + 1,
            eventType: "assistant",
            eventData: {
              message: { content: [{ type: "text", text: content }] },
            },
            createdAt: "2026-03-10T00:01:00Z",
          },
        ];
      }
      updateChatRun(threadId);
      createChatMessage(threadId);
    },
    failRun: (error: string) => {
      runStatus = "failed";
      runError = error;
      assistantVersion++;
      updateChatRun(threadId);
      createChatMessage(threadId);
    },
    cancelRun: () => {
      runStatus = "cancelled";
      assistantVersion++;
      updateChatRun(threadId);
      createChatMessage(threadId);
    },
    clearPendingMessage: () => {
      pendingMessage = null;
    },
  };
}
