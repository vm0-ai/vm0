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
  type GenerationTemplateRequest,
  type PagedChatMessage,
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
const MOCK_RUN_ID = "d0000000-0000-4000-a000-000000000001";
const SUB_AGENT_ID = "a1111111-0000-4000-a000-000000000001";

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
        latestSessionId: null,
        activeRunIds: [],
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        draftContent: null,
        draftAttachments: null,
      });
    }),
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, {
        pinned: [],
        threads: [],
        hasMore: false,
        nextCursor: null,
        totalCount: 0,
      });
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
          customSkills: [],
        },
        [SUB_AGENT_ID]: {
          agentId: SUB_AGENT_ID,
          ownerId: "test-user",
          displayName: "Assistant",
          description: null,
          sound: null,
          avatarUrl: "https://example.com/avatar.png",
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
  running: boolean;
  pinnedAt?: string | null;
}

type PagedThreadItem = ThreadListItem & {
  hasDraft?: boolean;
  pinnedAt?: string | null;
  renamedAt?: string | null;
};

/**
 * Splits a flat ThreadListItem array into the new paged response shape that
 * the chatThreadsContract.list endpoint returns. Pinned items go to `pinned`,
 * the rest to `threads`; pagination metadata defaults to "no more pages"
 * since fixtures rarely care about cursor mechanics.
 */
export function splitChatThreadListResponse(
  threads: readonly PagedThreadItem[],
): {
  pinned: PagedThreadItem[];
  threads: PagedThreadItem[];
  hasMore: boolean;
  nextCursor: string | null;
  totalCount: number;
} {
  const pinned = threads.filter((t) => {
    return t.pinnedAt !== null && t.pinnedAt !== undefined;
  });
  const nonPinned = threads.filter((t) => {
    return t.pinnedAt === null || t.pinnedAt === undefined;
  });
  return {
    pinned,
    threads: nonPinned,
    hasMore: false,
    nextCursor: null,
    totalCount: nonPinned.length,
  };
}

interface MockLifecycleControl {
  setRunStatus: (status: RunStatus) => void;
  setQueuePosition: (n: number) => void;
  setEvents: (e: AgentEvent[]) => void;
  setThreadList: (list: ThreadListItem[]) => void;
  completeRun: (content?: string) => void;
  failRun: (error: string) => void;
  cancelRun: () => void;
}

type MockPagedMessage =
  | (Omit<Extract<PagedChatMessage, { role: "user" }>, "id"> & {
      id?: string;
    })
  | (Omit<Extract<PagedChatMessage, { role: "assistant" }>, "id"> & {
      id?: string;
    });

function isRecallMessageBody(body: { revokesMessageId?: string }): body is {
  revokesMessageId: string;
  threadId: string;
  clientMessageId?: string;
} {
  return body.revokesMessageId !== undefined;
}

function isInterruptMessageBody(body: { interruptsRunId?: string }): body is {
  interruptsRunId: string;
  threadId: string;
  clientMessageId?: string;
} {
  return body.interruptsRunId !== undefined;
}

function appendSeedChatMessages(args: {
  pagedMessages: (MockPagedMessage & { id: string })[];
  chatMessages: MockPagedMessage[];
  terminalStatuses: Set<string>;
}) {
  const defaultedRunIds = new Set<string>();
  const terminalRunIds = new Set<string>();
  const activeRunIds = new Set<string>();
  for (let i = 0; i < args.chatMessages.length; i++) {
    const seed = args.chatMessages[i]!;
    const runId = "runId" in seed ? seed.runId : MOCK_RUN_ID;
    collectSeedRunState({
      seed,
      runId,
      defaultedRunIds,
      terminalRunIds,
      activeRunIds,
      terminalStatuses: args.terminalStatuses,
    });
    args.pagedMessages.push({
      ...seed,
      id: seed.id ?? `msg-seed-${i}`,
      runId,
    });
  }
  appendDefaultCompletionMarkers({
    pagedMessages: args.pagedMessages,
    defaultedRunIds,
    terminalRunIds,
    activeRunIds,
  });
}

function collectSeedRunState(args: {
  seed: MockPagedMessage;
  runId: string | undefined;
  defaultedRunIds: Set<string>;
  terminalRunIds: Set<string>;
  activeRunIds: Set<string>;
  terminalStatuses: Set<string>;
}) {
  if (!("runId" in args.seed) && args.runId !== undefined) {
    args.defaultedRunIds.add(args.runId);
  }
  if (
    args.seed.role === "assistant" &&
    args.seed.runId !== undefined &&
    args.seed.runLifecycleEvent !== undefined
  ) {
    args.terminalRunIds.add(args.seed.runId);
  }
  if (
    args.seed.role === "assistant" &&
    args.seed.runId !== undefined &&
    args.seed.status !== undefined &&
    !args.terminalStatuses.has(args.seed.status)
  ) {
    args.activeRunIds.add(args.seed.runId);
  }
}

function appendDefaultCompletionMarkers(args: {
  pagedMessages: (MockPagedMessage & { id: string })[];
  defaultedRunIds: Set<string>;
  terminalRunIds: Set<string>;
  activeRunIds: Set<string>;
}) {
  for (const runId of args.defaultedRunIds) {
    if (args.terminalRunIds.has(runId) || args.activeRunIds.has(runId)) {
      continue;
    }
    args.pagedMessages.push({
      id: `msg-seed-marker-${runId}`,
      role: "assistant",
      content: null,
      runId,
      runLifecycleEvent: "completed",
      createdAt: "2026-03-10T00:00:59Z",
    });
  }
}

export function mockChatLifecycle(options?: {
  threadId?: string;
  historyMessages?: MockPagedMessage[];
  chatMessages?: MockPagedMessage[];
  threadTitle?: string | null;
  onQueuedMessageAppend?: (body: {
    content?: string;
    attachments?: PersistedAttachment[];
    clientMessageId: string;
    generationTemplate?: GenerationTemplateRequest;
  }) => void;
  onRecallMessageAppend?: (body: {
    revokesMessageId: string;
    clientMessageId: string;
  }) => void;
  onInterruptMessageAppend?: (body: {
    interruptsRunId: string;
    clientMessageId: string;
  }) => void;
  /**
   * Promise the append handler awaits before responding. Lets a test observe
   * the optimistic queued row before the server round-trip completes.
   */
  appendGate?: Promise<void>;
  /**
   * Promise the initial send handler awaits before responding. Lets tests
   * keep the new-thread optimistic view mounted while interacting with it.
   */
  sendGate?: Promise<void>;
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
  let runUserMessageId = "msg-user-sent";
  let runAssociated = false;
  let threadTitle: string | null = options?.threadTitle ?? null;
  const queuedMessages: MockPagedMessage[] = [];
  // Version counter: bumped whenever the run reaches a terminal state so
  // subsequent polls discover a "new" assistant message row (simulating the
  // real server inserting event-backed rows on run completion).
  let assistantVersion = 0;
  let lastDeliveredVersion = -1;

  const rememberRunUserMessageId = (clientMessageId: string | undefined) => {
    if (clientMessageId !== undefined) {
      runUserMessageId = clientMessageId;
    }
  };

  const markRunCancelled = () => {
    if (runStatus === "cancelled") {
      return;
    }
    runStatus = "cancelled";
    runError = "Run cancelled";
    assistantVersion++;
    updateChatRun(threadId);
    createChatMessage(threadId);
  };

  const appendRecallControlMessage = (body: {
    revokesMessageId: string;
    threadId: string;
    clientMessageId?: string;
  }) => {
    const clientMessageId = body.clientMessageId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    options?.onRecallMessageAppend?.({
      revokesMessageId: body.revokesMessageId,
      clientMessageId,
    });
    queuedMessages.push({
      id: clientMessageId,
      role: "user" as const,
      content: null,
      revokesMessageId: body.revokesMessageId,
      createdAt: now,
    });
    return { runId: null, threadId: body.threadId, createdAt: now };
  };

  const appendInterruptControlMessage = (body: {
    interruptsRunId: string;
    threadId: string;
    clientMessageId?: string;
  }) => {
    const clientMessageId = body.clientMessageId ?? crypto.randomUUID();
    const now = new Date().toISOString();
    options?.onInterruptMessageAppend?.({
      interruptsRunId: body.interruptsRunId,
      clientMessageId,
    });
    queuedMessages.push({
      id: clientMessageId,
      role: "user" as const,
      content: null,
      interruptsRunId: body.interruptsRunId,
      createdAt: now,
    });
    markRunCancelled();
    return { runId: null, threadId: body.threadId, createdAt: now };
  };

  const terminal = new Set(["completed", "failed", "cancelled", "timeout"]);

  const hasActiveRun = () => {
    const hasSeedActiveRun = chatMessages.some((m) => {
      const status = m.role === "assistant" ? m.status : undefined;
      return (
        m.runId !== undefined && status !== undefined && !terminal.has(status)
      );
    });
    return hasSeedActiveRun || (runAssociated && !terminal.has(runStatus));
  };

  const appendQueuedUserMessage = async (body: {
    prompt?: string;
    attachFiles?: {
      id: string;
      filename: string;
      contentType: string;
      size: number;
    }[];
    clientMessageId?: string;
    generationTemplate?: GenerationTemplateRequest;
  }) => {
    const clientMessageId = body.clientMessageId ?? crypto.randomUUID();
    const attachFiles = body.attachFiles?.map((file) => {
      return {
        ...file,
        url: `https://cdn.vm7.io/artifacts/test/${file.id}/${file.filename}`,
      };
    });
    options?.onQueuedMessageAppend?.({
      content: body.prompt,
      attachments: attachFiles,
      clientMessageId,
      generationTemplate: body.generationTemplate,
    });
    if (options?.appendGate) {
      await options.appendGate;
    }
    const now = new Date().toISOString();
    queuedMessages.push({
      id: clientMessageId,
      role: "user" as const,
      content: body.prompt ?? "",
      attachFiles,
      generationTemplate: body.generationTemplate,
      createdAt: now,
    });
    return { runId: null, threadId, createdAt: now };
  };

  const startRunFromUserMessage = async (body: {
    prompt?: string;
    clientMessageId?: string;
  }) => {
    if (options?.sendGate) {
      await options.sendGate;
    }
    if (body.prompt) {
      runPrompt = body.prompt;
    }
    rememberRunUserMessageId(body.clientMessageId);
    options?.onRunCreate?.();
    runAssociated = true;
    createChatRun(threadId);
    createChatMessage(threadId);
    return {
      runId: MOCK_RUN_ID,
      threadId,
      status: "pending" as const,
      createdAt: "2026-03-10T00:00:00Z",
    };
  };

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

      const pagedMessages: (MockPagedMessage & { id: string })[] = [];

      for (const message of historicalMessages) {
        pagedMessages.push(message);
      }

      // Seed with pre-existing chatMessages (e.g. history on resume). Seeded
      // entries represent historical messages, so default `runId` to the mock
      // run when the test didn't include the key — without it, user messages
      // would look "unassociated" (runId === undefined) and be treated as
      // queued. Tests that *want* a queued seed should explicitly pass
      // `runId: undefined`, which we respect via the `in` check.
      appendSeedChatMessages({
        pagedMessages,
        chatMessages,
        terminalStatuses: terminal,
      });

      for (const message of queuedMessages) {
        pagedMessages.push({
          id: message.id ?? `queued-${pagedMessages.length}`,
          ...message,
        });
      }

      // After a run is associated, append user + assistant messages
      if (runAssociated) {
        pagedMessages.push({
          id: runUserMessageId,
          role: "user",
          content: runPrompt ?? "Hello",
          runId: MOCK_RUN_ID,
          createdAt: "2026-03-10T00:00:01Z",
        });
        pagedMessages.push({
          id: assistantId,
          role: "assistant",
          content: resultContent || null,
          runId: MOCK_RUN_ID,
          error: runError ?? undefined,
          status: runStatus,
          runLifecycleEvent:
            runStatus === "failed" || runStatus === "cancelled"
              ? runStatus
              : undefined,
          createdAt: "2026-03-10T00:00:02Z",
        });
        if (runStatus === "completed") {
          pagedMessages.push({
            id: `msg-assistant-run-marker-v${assistantVersion}`,
            role: "assistant",
            content: null,
            runId: MOCK_RUN_ID,
            runLifecycleEvent: "completed",
            createdAt: "2026-03-10T00:00:03Z",
          });
        }
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
          const messages =
            runStatus === "completed"
              ? pagedMessages.slice(Math.max(0, pagedMessages.length - 2))
              : [pagedMessages[pagedMessages.length - 1]!];
          return respond(200, {
            messages,
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
        .filter((m) => {
          const status = m.role === "assistant" ? m.status : undefined;
          return (
            m.runId !== undefined &&
            status !== undefined &&
            !terminal.has(status)
          );
        })
        .map((m) => {
          return m.runId!;
        });
      const lifecycleActiveRunIds =
        runAssociated && !terminal.has(runStatus) ? [MOCK_RUN_ID] : [];
      const activeRunIds = [...seedActiveRunIds, ...lifecycleActiveRunIds];
      return respond(200, {
        id: threadId,
        title: threadTitle,
        agentId: "c0000000-0000-4000-a000-000000000001",
        latestSessionId: null,
        activeRunIds,
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        draftContent: null,
        draftAttachments: null,
      });
    }),
    mockApi(chatThreadsContract.list, ({ respond }) => {
      return respond(200, splitChatThreadListResponse(threadList));
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
    mockApi(chatMessagesContract.send, async ({ body, respond }) => {
      if (isRecallMessageBody(body)) {
        return respond(201, appendRecallControlMessage(body));
      }

      if (isInterruptMessageBody(body)) {
        return respond(201, appendInterruptControlMessage(body));
      }

      threadId = body.clientThreadId ?? threadId;
      const responseBody = hasActiveRun()
        ? await appendQueuedUserMessage(body)
        : await startRunFromUserMessage(body);
      return respond(201, responseBody);
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
      markRunCancelled();
    },
  };
}
