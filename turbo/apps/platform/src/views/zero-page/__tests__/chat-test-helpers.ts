import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";
import {
  createChatMessage,
  createChatRun,
  updateChatRun,
} from "../../../mocks/mock-helpers.ts";
import type { AgentEvent } from "../../../signals/zero-page/log-types.ts";
import {
  chatThreadsContract,
  chatThreadByIdContract,
  chatThreadComputerUseHostContract,
  chatThreadDraftContract,
  chatThreadModelSelectionContract,
  chatThreadEventsContract,
  chatEventsContract,
  MODEL_FIRST_SELECTION_PROVIDER_ID,
  type ChatRunOptionsRequest,
  type CodexServiceTier,
  type GenerationTemplateRequest,
  type PersistedAttachment,
  type UserMessageDocument,
} from "@vm0/api-contracts/contracts/chat-threads";
import { logsByIdContract } from "@vm0/api-contracts/contracts/logs";
import {
  zeroRunAgentEventsContract,
  zeroRunsCancelContract,
  zeroRunsByIdContract,
} from "@vm0/api-contracts/contracts/zero-runs";
import { zeroComputerUseHostsContract } from "@vm0/api-contracts/contracts/zero-computer-use";
import { zeroQueuePositionContract } from "@vm0/api-contracts/contracts/zero-queue-position";
import { zeroTeamContract } from "@vm0/api-contracts/contracts/zero-team";
import { zeroAgentsByIdContract } from "@vm0/api-contracts/contracts/zero-agents";
import type { RunStatus } from "@vm0/api-contracts/contracts/runs";
import {
  normalizeMockChatEvents,
  type MockChatEventInput,
} from "./chat-event-test-helpers.ts";

import { fill } from "../../../__tests__/page-helper.ts";
import { nowIso } from "../../../__tests__/time.ts";
import type { TestContext } from "../../../signals/__tests__/test-helpers.ts";

export const PLACEHOLDER = "Ask me to automate workflows, manage tasks...";

const DEFAULT_AGENT_ID = "c0000000-0000-4000-a000-000000000001";
const MOCK_RUN_ID = "d0000000-0000-4000-a000-000000000001";
const SUB_AGENT_ID = "a1111111-0000-4000-a000-000000000001";

interface ModelSelectionRequest {
  readonly modelProviderId: string;
  readonly selectedModel: string;
}

function modelFirstSelection(selectedModel: string): ModelSelectionRequest {
  return {
    modelProviderId: MODEL_FIRST_SELECTION_PROVIDER_ID,
    selectedModel,
  };
}

function modelSelectionFromBody(body: {
  readonly model?: string | null;
}): ModelSelectionRequest | null | undefined {
  if (body.model === undefined) {
    return undefined;
  }
  return body.model === null ? null : modelFirstSelection(body.model);
}

export function mockSubagentThread(context: TestContext, _threadId: string) {
  context.mocks.data.team([
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
  context.mocks.api(zeroTeamContract.list, ({ respond }) => {
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
  });
  context.mocks.api(chatThreadEventsContract.list, ({ respond }) => {
    return respond(200, { events: [] });
  });
  context.mocks.api(chatThreadByIdContract.get, ({ respond }) => {
    return respond(200, {
      lastReadAt: null,
    });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftContent: null,
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  context.mocks.api(zeroAgentsByIdContract.get, ({ params, respond }) => {
    const agents: Record<
      string,
      {
        agentId: string;
        displayName: string | null;
        ownerId: string;
        description: null;
        sound: null;
        avatarUrl: string | null;
        modelProviderId: string | null;
        selectedModel: string | null;
        preferPersonalProvider: boolean;
      }
    > = {
      [DEFAULT_AGENT_ID]: {
        agentId: DEFAULT_AGENT_ID,
        ownerId: "test-user",
        displayName: null,
        description: null,
        sound: null,
        avatarUrl: null,
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      },
      [SUB_AGENT_ID]: {
        agentId: SUB_AGENT_ID,
        ownerId: "test-user",
        displayName: "Assistant",
        description: null,
        sound: null,
        avatarUrl: "https://example.com/avatar.png",
        modelProviderId: null,
        selectedModel: null,
        preferPersonalProvider: false,
      },
    };
    const agent = agents[params.id];
    if (!agent) {
      return respond(404, {
        error: { message: "Not found", code: "NOT_FOUND" },
      });
    }
    return respond(200, agent);
  });
  context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [] });
  });
}

export async function sendMessageInUI(
  user: ReturnType<typeof userEvent.setup>,
  input: Element,
  text: string,
): Promise<void> {
  await fill(input, text);
  await user.keyboard("{Enter}");
}

export function activeRunComposer(): Promise<HTMLElement> {
  return waitFor(() => {
    return screen.getByRole("textbox", { name: "Message" });
  });
}

export async function sendQueuedMessage(
  user: ReturnType<typeof userEvent.setup>,
  text: string,
): Promise<void> {
  const composer = await activeRunComposer();
  await fill(composer, text);
  await user.keyboard("{Enter}");
}

export async function expectQueuedMessages(contents: string[]): Promise<void> {
  await waitFor(() => {
    const queuedMessages = screen.getAllByLabelText("Queued message");
    expect(queuedMessages).toHaveLength(contents.length);
    for (const [index, content] of contents.entries()) {
      expect(queuedMessages[index]).toHaveTextContent(content);
    }
  });
}

interface ThreadListItem {
  id: string;
  title: string | null;
  agent: { id: string; avatarUrl: string | null };
  createdAt: string;
  updatedAt: string;
  pinnedAt?: string | null;
  renamedAt?: string | null;
  selectedModel?: string | null;
  serviceTier?: "priority" | null;
  computerUseHostId?: string | null;
  cloudBrowserEnabled?: boolean;
}

const UUID_PATTERN =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$/;

export function threadListSnapshot(threads: readonly ThreadListItem[]) {
  return threads.map((thread) => {
    return {
      id: thread.id,
      agentId: thread.agent.id,
      title: thread.title,
      sortAt: thread.updatedAt,
      createdAt: thread.createdAt,
      updatedAt: thread.updatedAt,
      pinnedAt: thread.pinnedAt ?? null,
      renamedAt: thread.renamedAt ?? null,
      selectedModel: thread.selectedModel ?? null,
      serviceTier: thread.serviceTier ?? null,
      computerUseHostId: thread.computerUseHostId ?? null,
      cloudBrowserEnabled: thread.cloudBrowserEnabled ?? false,
    };
  });
}

interface MockLifecycleControl {
  setRunStatus: (status: RunStatus) => void;
  setQueuePosition: (n: number) => void;
  setEvents: (e: AgentEvent[]) => void;
  setThreadList: (list: ThreadListItem[]) => void;
  setCodexServiceTier: (tier: CodexServiceTier | null) => void;
  completeRun: (content?: string) => void;
  failRun: (error: string) => void;
  cancelRun: () => void;
}

type MockChatEvent = MockChatEventInput;

function cloneMockChatEvent<T extends MockChatEventInput>(message: T): T {
  return structuredClone(message);
}

function isRecallEventBody(body: {
  revokesEventId?: string;
  prompt?: string;
}): body is {
  revokesEventId: string;
  threadId: string;
  clientEventId?: string;
} {
  return body.revokesEventId !== undefined && body.prompt === undefined;
}

function isInterruptEventBody(body: { interruptsRunId?: string }): body is {
  interruptsRunId: string;
  threadId: string;
  clientEventId?: string;
} {
  return body.interruptsRunId !== undefined;
}

function appendSeedChatMessages(args: {
  pagedEvents: (MockChatEvent & { id: string })[];
  chatMessages: MockChatEvent[];
  activeRunIds: readonly string[];
}) {
  const completionCandidateRuns = new Map<string, string>();
  const terminalRunIds = new Set<string>();
  for (let i = 0; i < args.chatMessages.length; i++) {
    const seed = args.chatMessages[i]!;
    const runId = "runId" in seed ? seed.runId : MOCK_RUN_ID;
    collectSeedRunState({
      seed,
      runId,
      completionCandidateRuns,
      terminalRunIds,
    });
    args.pagedEvents.push({
      ...seed,
      id: seed.id ?? `msg-seed-${i}`,
      runId,
    });
  }
  appendDefaultCompletionMarkers({
    pagedEvents: args.pagedEvents,
    completionCandidateRuns,
    terminalRunIds,
    activeRunIds: new Set(args.activeRunIds),
  });
}

function markerCreatedAtAfter(createdAt: string): string {
  return new Date(new Date(createdAt).getTime() + 1).toISOString();
}

function addCompletionCandidate(
  runs: Map<string, string>,
  runId: string,
  createdAt: string,
): void {
  const markerCreatedAt = markerCreatedAtAfter(createdAt);
  const current = runs.get(runId);
  if (current === undefined || current < markerCreatedAt) {
    runs.set(runId, markerCreatedAt);
  }
}

function collectSeedRunState(args: {
  seed: MockChatEvent;
  runId: string | undefined;
  completionCandidateRuns: Map<string, string>;
  terminalRunIds: Set<string>;
}) {
  if (!("runId" in args.seed) && args.runId !== undefined) {
    addCompletionCandidate(
      args.completionCandidateRuns,
      args.runId,
      args.seed.createdAt,
    );
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
    args.runId !== undefined &&
    args.seed.content !== null &&
    args.seed.runEventId === undefined
  ) {
    addCompletionCandidate(
      args.completionCandidateRuns,
      args.runId,
      args.seed.createdAt,
    );
  }
}

function appendDefaultCompletionMarkers(args: {
  pagedEvents: (MockChatEvent & { id: string })[];
  completionCandidateRuns: Map<string, string>;
  terminalRunIds: Set<string>;
  activeRunIds: Set<string>;
}) {
  for (const [runId, createdAt] of args.completionCandidateRuns) {
    if (args.terminalRunIds.has(runId) || args.activeRunIds.has(runId)) {
      continue;
    }
    args.pagedEvents.push({
      id: `msg-seed-marker-${runId}`,
      role: "assistant",
      content: null,
      runId,
      runLifecycleEvent: "completed",
      createdAt,
    });
  }
}

export function mockChatLifecycle(
  context: TestContext,
  options?: {
    threadId?: string;
    historyEvents?: MockChatEvent[];
    chatMessages?: MockChatEvent[];
    threadTitle?: string | null;
    selectedModel?: string | null;
    codexServiceTier?: CodexServiceTier | null;
    computerUseHostId?: string | null;
    cloudBrowserEnabled?: boolean;
    activeRunIds?: string[];
    onQueuedMessageAppend?: (body: {
      content?: string;
      hasTextContent?: boolean;
      attachments?: PersistedAttachment[];
      clientEventId: string;
      generationTemplate?: GenerationTemplateRequest;
      userMessage?: UserMessageDocument;
      modelSelection?: ModelSelectionRequest | null;
      runOptions?: ChatRunOptionsRequest;
    }) => void;
    onRecallMessageAppend?: (body: {
      revokesEventId: string;
      clientEventId: string;
    }) => void;
    onInterruptMessageAppend?: (body: {
      interruptsRunId: string;
      clientEventId: string;
    }) => void;
    onComputerUseHostUpdate?: (body: {
      computerUseHostId: string | null;
      cloudBrowserEnabled?: boolean;
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
    /**
     * Promise the paged history handler awaits before responding to beforeSeqId.
     * Lets tests prove the latest-message view renders before silent backfill.
     */
    beforeHistoryGate?: Promise<void>;
    /**
     * Promise the thread metadata handler awaits before responding. Lets tests
     * prove message-derived UI does not wait for activeRunIds metadata.
     */
    threadGate?: Promise<void>;
    afterInitialMessagesList?: () => void;
    onRunCreate?: (body: {
      prompt?: string;
      clientEventId?: string;
      clientThreadId?: string;
      attachFiles?: {
        id: string;
        filename: string;
        contentType: string;
        size: number;
      }[];
      hasTextContent?: boolean;
      generationTemplate?: GenerationTemplateRequest;
      userMessage?: UserMessageDocument;
      model?: string;
      modelSelection?: ModelSelectionRequest | null;
      runOptions?: ChatRunOptionsRequest;
      computerUseHostId?: string | null;
      cloudBrowserEnabled?: boolean;
      revokesEventId?: string;
    }) => void;
    onSendRequest?: (body: {
      prompt: string;
      threadId?: string;
      clientThreadId?: string;
      userMessage?: UserMessageDocument;
      model?: string;
      modelSelection?: ModelSelectionRequest | null;
      computerUseHostId?: string | null;
      cloudBrowserEnabled?: boolean;
    }) => void;
    onThreadCreate?: (body: {
      clientThreadId?: string;
      model?: string;
      modelSelection: ModelSelectionRequest;
    }) => void;
    onModelSelectionUpdate?: (body: {
      model?: string | null;
      modelSelection?: ModelSelectionRequest | null;
      codexServiceTier?: CodexServiceTier | null;
    }) => void;
  },
): MockLifecycleControl {
  let threadId = options?.threadId ?? "b0000000-0000-4000-a000-000000000900";
  const historyEvents = options?.historyEvents ?? [];
  const chatMessages = options?.chatMessages ?? [];

  let runStatus: RunStatus = "running";
  let runError: string | null = null;
  let events: AgentEvent[] = [];
  let queuePosition = 0;
  let resultContent = "";
  let threadListOverride: ThreadListItem[] | null = null;
  let runPrompt: string | null = null;
  let runUserEventId = "msg-user-sent";
  let runUserMessage: UserMessageDocument | undefined;
  let runAssociated = false;
  let threadTitle: string | null = options?.threadTitle ?? null;
  let selectedModel: string | null = options?.selectedModel ?? null;
  let codexServiceTier: CodexServiceTier | null =
    options?.codexServiceTier ?? null;
  let computerUseHostId: string | null = options?.computerUseHostId ?? null;
  let cloudBrowserEnabled = options?.cloudBrowserEnabled ?? false;
  let latestThreadEventId: string | null = null;
  let latestThreadEventSeqId: number | null = null;
  const queuedMessages: MockChatEvent[] = [];
  const optionActiveRunIds = options?.activeRunIds ?? [];
  // Version counter: bumped whenever the run reaches a terminal state so
  // subsequent polls discover a "new" assistant message row (simulating the
  // real server inserting event-backed rows on run completion).
  let assistantVersion = 0;
  let lastDeliveredVersion = -1;

  const rememberRunUserEventId = (clientEventId: string | undefined) => {
    if (clientEventId !== undefined) {
      runUserEventId = clientEventId;
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

  const appendRecallControlEvent = (body: {
    revokesEventId: string;
    threadId: string;
    clientEventId?: string;
  }) => {
    const clientEventId = body.clientEventId ?? crypto.randomUUID();
    const now = nowIso();
    options?.onRecallMessageAppend?.({
      revokesEventId: body.revokesEventId,
      clientEventId,
    });
    queuedMessages.push({
      id: clientEventId,
      role: "user" as const,
      content: null,
      revokesEventId: body.revokesEventId,
      createdAt: now,
    });
    return { runId: null, threadId: body.threadId, createdAt: now };
  };

  const appendInterruptControlEvent = (body: {
    interruptsRunId: string;
    threadId: string;
    clientEventId?: string;
  }) => {
    const clientEventId = body.clientEventId ?? crypto.randomUUID();
    const now = nowIso();
    options?.onInterruptMessageAppend?.({
      interruptsRunId: body.interruptsRunId,
      clientEventId,
    });
    queuedMessages.push({
      id: clientEventId,
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
    return (
      optionActiveRunIds.length > 0 ||
      (runAssociated && !terminal.has(runStatus))
    );
  };

  const effectiveThreadList = () => {
    if (threadListOverride !== null) {
      return threadListOverride;
    }
    if (!UUID_PATTERN.test(threadId)) {
      return [];
    }
    return [
      {
        id: threadId,
        title: threadTitle,
        agent: {
          id: "c0000000-0000-4000-a000-000000000001",
          avatarUrl: null,
        },
        createdAt: "2026-03-10T00:00:00Z",
        updatedAt: "2026-03-10T00:00:00Z",
        pinnedAt: null,
        selectedModel,
        serviceTier: codexServiceTier === "fast" ? ("priority" as const) : null,
        computerUseHostId,
        cloudBrowserEnabled,
      },
    ];
  };

  const buildCanonicalEvents = (): (MockChatEvent & {
    id: string;
    seqId: number;
  })[] => {
    const assistantId = `msg-assistant-run-v${assistantVersion}`;
    const historicalEvents = historyEvents.map((message, i) => {
      return {
        id: `msg-history-${i}`,
        ...message,
      };
    });

    const pagedEvents: (MockChatEvent & { id: string })[] = [];

    for (const message of historicalEvents) {
      pagedEvents.push(message);
    }

    // Seed with pre-existing chatMessages (e.g. history on resume). Seeded
    // entries represent historical messages, so default `runId` to the mock
    // run when the test didn't include the key — without it, user messages
    // would look "unassociated" (runId === undefined) and be treated as
    // queued. Tests that *want* a queued seed should explicitly pass
    // `runId: undefined`, which we respect via the `in` check.
    appendSeedChatMessages({
      pagedEvents,
      chatMessages,
      activeRunIds: optionActiveRunIds,
    });

    for (const message of queuedMessages) {
      pagedEvents.push({
        id: message.id ?? `queued-${pagedEvents.length}`,
        ...message,
      });
    }

    // After a run is associated, append user + assistant messages.
    if (runAssociated) {
      pagedEvents.push({
        id: runUserEventId,
        role: "user",
        content: runPrompt ?? "Hello",
        ...(runUserMessage ? { userMessage: runUserMessage } : {}),
        runId: MOCK_RUN_ID,
        createdAt: "2026-03-10T00:00:01Z",
      });
      pagedEvents.push({
        id: assistantId,
        role: "assistant",
        content: resultContent || null,
        runId: MOCK_RUN_ID,
        error: runError ?? undefined,
        runLifecycleEvent:
          runStatus === "failed" || runStatus === "cancelled"
            ? runStatus
            : undefined,
        createdAt: "2026-03-10T00:00:02Z",
      });
      if (runStatus === "completed") {
        pagedEvents.push({
          id: `msg-assistant-run-marker-v${assistantVersion}`,
          role: "assistant",
          content: null,
          runId: MOCK_RUN_ID,
          runLifecycleEvent: "completed",
          createdAt: "2026-03-10T00:00:03Z",
        });
      }
    }

    return pagedEvents.map((message, index) => {
      return { ...message, seqId: index + 1 };
    });
  };

  const appendQueuedUserMessage = async (body: {
    prompt?: string;
    attachFiles?: {
      id: string;
      filename: string;
      contentType: string;
      size: number;
    }[];
    clientEventId?: string;
    hasTextContent?: boolean;
    generationTemplate?: GenerationTemplateRequest;
    userMessage?: UserMessageDocument;
    model?: string;
    runOptions?: ChatRunOptionsRequest;
  }) => {
    const clientEventId = body.clientEventId ?? crypto.randomUUID();
    const attachFiles = body.attachFiles?.map((file) => {
      return {
        ...file,
        url: `https://cdn.vm7.io/artifacts/test/${file.id}/${file.filename}`,
      };
    });
    const modelSelection = modelSelectionFromBody(body);
    options?.onQueuedMessageAppend?.({
      content: body.prompt,
      hasTextContent: body.hasTextContent,
      attachments: attachFiles,
      clientEventId,
      generationTemplate: body.generationTemplate,
      userMessage: body.userMessage,
      modelSelection,
      runOptions: body.runOptions,
    });
    if (options?.appendGate) {
      await options.appendGate;
    }
    const now = nowIso();
    queuedMessages.push({
      id: clientEventId,
      role: "user" as const,
      content: body.prompt ?? "",
      attachFiles,
      generationTemplate: body.generationTemplate,
      ...(body.userMessage ? { userMessage: body.userMessage } : {}),
      createdAt: now,
    });
    return { runId: null, threadId, createdAt: now };
  };

  const startRunFromUserMessage = async (body: {
    prompt?: string;
    clientEventId?: string;
    attachFiles?: {
      id: string;
      filename: string;
      contentType: string;
      size: number;
    }[];
    hasTextContent?: boolean;
    generationTemplate?: GenerationTemplateRequest;
    userMessage?: UserMessageDocument;
    model?: string;
    runOptions?: ChatRunOptionsRequest;
    computerUseHostId?: string | null;
    cloudBrowserEnabled?: boolean;
    revokesEventId?: string;
  }) => {
    if (options?.sendGate) {
      await options.sendGate;
    }
    if (body.prompt) {
      runPrompt = body.prompt;
    }
    runUserMessage = body.userMessage;
    if (body.cloudBrowserEnabled === true) {
      computerUseHostId = null;
      cloudBrowserEnabled = true;
    } else if (body.computerUseHostId) {
      computerUseHostId = body.computerUseHostId;
      cloudBrowserEnabled = false;
    }
    rememberRunUserEventId(body.clientEventId);
    const modelSelection = modelSelectionFromBody(body);
    options?.onRunCreate?.({ ...body, modelSelection });
    selectedModel = modelSelection?.selectedModel ?? selectedModel;
    codexServiceTier = body.runOptions?.codexServiceTier ?? null;
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

  // Paged messages endpoint — cursor-aware, version-aware mock.
  context.mocks.api(chatThreadEventsContract.list, ({ query, respond }) => {
    const sinceSeqId = query.sinceSeqId;
    const beforeSeqId = query.beforeSeqId;
    const limit = query.limit ?? 50;
    const beforeHistoryGate = options?.beforeHistoryGate ?? Promise.resolve();
    const pagedEvents = buildCanonicalEvents();

    if (beforeSeqId) {
      return beforeHistoryGate.then(() => {
        const beforeIndex = pagedEvents.findIndex((message) => {
          return message.seqId === beforeSeqId;
        });
        if (beforeIndex <= 0) {
          return respond(200, { events: [], hasHistoryBefore: false });
        }
        const olderEvents = pagedEvents.slice(
          Math.max(0, beforeIndex - limit),
          beforeIndex,
        );
        return respond(200, {
          events: normalizeMockChatEvents(olderEvents.map(cloneMockChatEvent)),
          hasHistoryBefore: beforeIndex - olderEvents.length > 0,
        });
      });
    }

    if (sinceSeqId) {
      const appendedEvents = pagedEvents.filter((message) => {
        return message.seqId > sinceSeqId;
      });
      if (appendedEvents.length > 0) {
        return respond(200, {
          events: normalizeMockChatEvents(
            appendedEvents.map(cloneMockChatEvent),
          ),
        });
      }
      // If the assistant version bumped since the client's cursor, return
      // the updated assistant message as a "new" row. Otherwise return
      // empty to avoid duplicate keys.
      if (assistantVersion > lastDeliveredVersion && runAssociated) {
        lastDeliveredVersion = assistantVersion;
        const messages =
          runStatus === "completed"
            ? pagedEvents.slice(Math.max(0, pagedEvents.length - 2))
            : [pagedEvents[pagedEvents.length - 1]!];
        return respond(200, {
          events: normalizeMockChatEvents(messages.map(cloneMockChatEvent)),
        });
      }
      return respond(200, { events: [] });
    }

    lastDeliveredVersion = assistantVersion;
    const latestEvents = pagedEvents.slice(historyEvents.length);
    const body = {
      events: normalizeMockChatEvents(
        latestEvents
          .slice(Math.max(0, latestEvents.length - limit))
          .map(cloneMockChatEvent),
      ),
      hasHistoryBefore: historyEvents.length > 0 || latestEvents.length > limit,
    };
    options?.afterInitialMessagesList?.();
    return respond(200, body);
  });
  context.mocks.api(chatThreadByIdContract.get, async ({ respond }) => {
    if (options?.threadGate) {
      await options.threadGate;
    }
    return respond(200, {
      lastReadAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(chatThreadDraftContract.get, ({ respond }) => {
    return respond(200, {
      draftContent: null,
      draftUserMessage: null,
      draftAttachments: null,
    });
  });
  context.mocks.api(
    chatThreadModelSelectionContract.update,
    ({ body, respond }) => {
      const modelSelection = modelSelectionFromBody(body);
      selectedModel = modelSelection?.selectedModel ?? null;
      codexServiceTier = body.codexServiceTier ?? null;
      latestThreadEventId =
        body.serviceTierEventId ?? body.eventId ?? crypto.randomUUID();
      latestThreadEventSeqId = (latestThreadEventSeqId ?? 0) + 1;
      options?.onModelSelectionUpdate?.({
        model: body.model,
        modelSelection,
        codexServiceTier: body.codexServiceTier,
      });
      return respond(204);
    },
  );
  context.mocks.api(
    chatThreadComputerUseHostContract.update,
    ({ body, respond }) => {
      computerUseHostId = body.computerUseHostId;
      cloudBrowserEnabled =
        body.cloudBrowserEnabled ??
        (body.computerUseHostId ? false : cloudBrowserEnabled);
      latestThreadEventId = body.eventId ?? crypto.randomUUID();
      latestThreadEventSeqId = (latestThreadEventSeqId ?? 0) + 1;
      options?.onComputerUseHostUpdate?.({
        computerUseHostId: body.computerUseHostId,
        cloudBrowserEnabled: body.cloudBrowserEnabled,
      });
      return respond(204);
    },
  );
  context.mocks.api(chatThreadsContract.snapshot, ({ respond }) => {
    return respond(200, {
      chatThreads: threadListSnapshot(effectiveThreadList()),
      latestEventId: latestThreadEventId,
      latestSeqId: latestThreadEventSeqId,
    });
  });
  context.mocks.api(chatThreadsContract.events, ({ respond }) => {
    return respond(200, { events: [], hasMore: false });
  });
  context.mocks.api(chatThreadsContract.activeIds, ({ respond }) => {
    const activeThreadIds = new Set<string>();
    if (
      optionActiveRunIds.length > 0 ||
      (runAssociated && !terminal.has(runStatus))
    ) {
      activeThreadIds.add(threadId);
    }
    return respond(200, {
      threadIds: [...activeThreadIds].filter((id) => {
        return UUID_PATTERN.test(id);
      }),
    });
  });
  context.mocks.api(chatThreadsContract.create, ({ body, respond }) => {
    threadId = body.clientThreadId ?? threadId;
    const modelSelection = modelSelectionFromBody(body);
    if (!modelSelection) {
      throw new Error("Expected chat thread create to include model");
    }
    selectedModel = modelSelection.selectedModel;
    options?.onThreadCreate?.({
      clientThreadId: body.clientThreadId,
      model: body.model,
      modelSelection,
    });
    return respond(201, {
      id: threadId,
      title: null,
      createdAt: "2026-03-10T00:00:00Z",
    });
  });
  // Unified chat event endpoint (creates thread + run + association)
  context.mocks.api(chatEventsContract.send, async ({ body, respond }) => {
    if (isRecallEventBody(body)) {
      return respond(201, appendRecallControlEvent(body));
    }

    if (isInterruptEventBody(body)) {
      return respond(201, appendInterruptControlEvent(body));
    }
    if (body.prompt === undefined) {
      throw new Error("Expected prompt for a normal chat event send");
    }

    options?.onSendRequest?.({
      prompt: body.prompt,
      threadId: body.threadId,
      clientThreadId: body.clientThreadId,
      userMessage: body.userMessage,
      model: body.model,
      modelSelection: modelSelectionFromBody(body),
      computerUseHostId: body.computerUseHostId,
      cloudBrowserEnabled: body.cloudBrowserEnabled,
    });
    threadId = body.clientThreadId ?? threadId;
    const responseBody = hasActiveRun()
      ? await appendQueuedUserMessage(body)
      : await startRunFromUserMessage(body);
    return respond(201, responseBody);
  });
  context.mocks.api(logsByIdContract.getById, ({ respond }) => {
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
      status: runStatus,
      prompt: "Hello",
      appendSystemPrompt: null,
      error: runError,
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
        events,
        hasMore: false,
        framework: "claude-code",
      });
    },
  );
  context.mocks.api(zeroRunsCancelContract.cancel, ({ respond }) => {
    return respond(200, {
      id: "a0000000-0000-4000-a000-000000000001",
      status: "cancelled",
      message: "Run cancelled",
    });
  });
  context.mocks.api(zeroRunsByIdContract.getById, ({ respond }) => {
    return respond(200, {
      runId: "a0000000-0000-4000-a000-000000000001",
      agentComposeVersionId: null,
      status: runStatus,
      prompt: runPrompt ?? "Hello",
      appendSystemPrompt: null,
      result: { agentSessionId: "session-1", output: resultContent },
      createdAt: "2026-03-10T00:00:00Z",
    });
  });
  context.mocks.api(zeroQueuePositionContract.getPosition, ({ respond }) => {
    return respond(200, { position: queuePosition, total: 0 });
  });
  context.mocks.api(zeroComputerUseHostsContract.list, ({ respond }) => {
    return respond(200, { hosts: [] });
  });

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
      threadListOverride = list;
    },
    setCodexServiceTier: (tier) => {
      codexServiceTier = tier;
      latestThreadEventId = crypto.randomUUID();
      latestThreadEventSeqId = (latestThreadEventSeqId ?? 0) + 1;
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
