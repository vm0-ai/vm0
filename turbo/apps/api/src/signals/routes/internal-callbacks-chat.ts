import { randomBytes } from "node:crypto";

import { command } from "ccstate";
import {
  chatCallbackPayloadSchema,
  internalCallbacksChatContract,
} from "@vm0/api-contracts/contracts/internal-callbacks-chat";
import type { ModelProviderCredentialScope } from "@vm0/api-contracts/contracts/model-providers";
import { agentRuns } from "@vm0/db/schema/agent-run";
import {
  chatMessages,
  type ChatMessageAttachFileMetadata,
} from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { orgModelPolicies } from "@vm0/db/schema/org-model-policy";
import { zeroAgents } from "@vm0/db/schema/zero-agent";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import {
  and,
  asc,
  desc,
  eq,
  inArray,
  isNotNull,
  isNull,
  sql,
} from "drizzle-orm";

import {
  callbackPayload$,
  callbackRoute,
} from "../../lib/callback-route/callback-route";
import { waitForRunEventWatermarkVisible } from "../../lib/agent-event-visibility";
import { escapeAplString } from "../../lib/axiom-apl";
import { env } from "../../lib/env";
import { logger } from "../../lib/log";
import { now } from "../../lib/time";
import type { RouteEntry } from "../route";
import { waitUntil } from "../context/wait-until";
import { getDatasetName, queryAxiomDirect } from "../external/axiom";
import { writeDb$, type Db } from "../external/db";
import {
  publishThreadListChanged,
  publishUserSignal,
} from "../external/realtime";
import { recordSandboxOperation } from "../external/sandbox-op-log";
import { saveRunSummary$ } from "../services/run-summary.service";
import {
  formatChatRunErrorMessage,
  insertAssistantEventMessages$,
  resolveAttachFileMetadataUrls,
  resolveAttachFileUrls,
  touchChatThreadLastMessageAt,
  visibleChatMessageCondition,
} from "../services/zero-chat-thread.service";
import { sendUserPushNotifications } from "../services/zero-push-notifications.service";
import {
  generateAndPersistChatThreadTitleFromCallback,
  generateChatNotificationSummary,
} from "../services/zero-chat-title.service";
import { createZeroRun$ } from "../services/zero-runs-create.service";
import { settle, tapError } from "../utils";

const log = logger("callback:chat");
const AGENT_RUN_EVENTS_DATASET = "agent-run-events";
const INCOMPLETE_MESSAGE_CHAR_CAP = 4000;

interface ContentBlock {
  readonly type?: string;
  readonly text?: string;
}

interface CodexItem {
  readonly type?: string;
  readonly text?: string;
}

interface AxiomChatOutputEvent {
  readonly eventType?: string;
  readonly sequenceNumber?: number;
  readonly eventData?: {
    readonly message?: { readonly content?: readonly ContentBlock[] };
    readonly item?: CodexItem;
    readonly result?: string;
    readonly sequenceNumber?: number;
  };
}

interface AssistantEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

interface ResultEventItem {
  readonly sequenceNumber: number;
  readonly content: string;
}

interface IncompleteRoundRow {
  readonly runId: string;
  readonly runStatus: "cancelled" | "failed" | "timeout";
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly error: string | null;
  readonly attachFiles: readonly string[] | null;
}

interface IncompleteRound {
  readonly runId: string;
  readonly status: "cancelled" | "failed" | "timeout";
  readonly messages: IncompleteRoundMessage[];
}

interface IncompleteRoundMessage {
  readonly role: "user" | "assistant";
  readonly content: string | null;
  readonly error: string | null;
  readonly attachFiles: readonly string[] | null;
}

interface QueuedUserMessage {
  readonly id: string;
  readonly content: string | null;
  readonly attachFiles: readonly string[] | null;
  readonly attachFileMetadata: readonly ChatMessageAttachFileMetadata[] | null;
  readonly modelProviderId: string | null;
  readonly modelProviderType: string | null;
  readonly modelProviderCredentialScope: ModelProviderCredentialScope | null;
  readonly selectedModel: string | null;
}

interface AgentForAutoSend {
  readonly id: string;
  readonly orgId: string;
}

interface ChatThreadForRunRow {
  readonly chatThreadId: string;
  readonly userId: string;
}

interface ChatRunInfo {
  readonly prompt: string;
  readonly error: string | null;
  readonly lastEventSequence: number | null;
}

interface CreateQueuedChatRunInput {
  readonly orgId: string;
  readonly userId: string;
  readonly agentId: string;
  readonly prompt: string;
  readonly sessionId: string | null;
  readonly appendSystemPrompt: string;
  readonly threadId: string;
  readonly queuedMessage: QueuedUserMessage;
}

function generateCallbackSecret(): string {
  return randomBytes(32).toString("hex");
}

function chatCallbackUrl(): string {
  return new URL("/api/internal/callbacks/chat", env("VM0_API_URL")).toString();
}

function parseModelProviderCredentialScope(
  value: string | null,
): ModelProviderCredentialScope | null {
  if (value === null || value === "org" || value === "member") {
    return value;
  }
  throw new Error(`Unknown model provider credential scope "${value}"`);
}

function buildQueuedCreateZeroRunArgs(
  input: CreateQueuedChatRunInput,
  apiStartTime: number,
) {
  return {
    auth: {
      tokenType: "session" as const,
      userId: input.userId,
      orgId: input.orgId,
      orgRole: "member" as const,
    },
    apiStartTime,
    chatThreadId: input.threadId,
    modelProviderId: input.queuedMessage.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      input.queuedMessage.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: input.queuedMessage.selectedModel ?? undefined,
    callbacks: [
      {
        url: chatCallbackUrl(),
        secret: generateCallbackSecret(),
        payload: {
          threadId: input.threadId,
          agentId: input.agentId,
        },
      },
    ],
    triggerSource: "web" as const,
    appendSystemPrompt: input.appendSystemPrompt,
    body: {
      prompt: input.prompt,
      agentId: input.agentId,
      ...(input.sessionId ? { sessionId: input.sessionId } : {}),
      ...(input.queuedMessage.modelProviderType
        ? { modelProvider: input.queuedMessage.modelProviderType }
        : {}),
    },
  };
}

function extractAnthropicContent(
  blocks: readonly ContentBlock[],
): string | null {
  const parts = blocks.flatMap((block) => {
    return block.type === "text" && typeof block.text === "string"
      ? [block.text]
      : [];
  });
  if (parts.length === 0) {
    return null;
  }
  return parts.length === 1 ? parts[0]! : parts.join("\n\n");
}

function extractCodexAgentMessageContent(item: CodexItem): string | null {
  if (
    item.type !== "agent_message" ||
    typeof item.text !== "string" ||
    item.text.length === 0
  ) {
    return null;
  }
  return item.text;
}

function extractAssistantContent(event: AxiomChatOutputEvent): string | null {
  const content = event.eventData?.message?.content;
  if (content) {
    return extractAnthropicContent(content);
  }
  const item = event.eventData?.item;
  if (item) {
    return extractCodexAgentMessageContent(item);
  }
  return null;
}

function extractResultFallback(
  sequenceNumber: number,
  event: AxiomChatOutputEvent,
): ResultEventItem | null {
  const result = event.eventData?.result;
  if (typeof result !== "string") {
    return null;
  }
  if (!result.trim()) {
    return null;
  }
  return { sequenceNumber, content: result };
}

async function queryChatOutputEvents(args: {
  readonly runId: string;
  readonly lastEventSequence: number | null;
  readonly signal: AbortSignal;
}): Promise<{
  readonly assistantItems: readonly AssistantEventItem[];
  readonly resultFallback: ResultEventItem | null;
}> {
  await waitForRunEventWatermarkVisible(args.runId, args.lastEventSequence);
  args.signal.throwIfAborted();

  const dataset = getDatasetName(AGENT_RUN_EVENTS_DATASET);
  const apl = `['${dataset}']
| where runId == "${escapeAplString(args.runId)}"
| where eventType == "assistant" or eventType == "result" or eventType == "item.completed"
| order by sequenceNumber asc
| limit 200`;

  const events = await queryAxiomDirect<AxiomChatOutputEvent>(apl, {
    noCache: true,
  });
  args.signal.throwIfAborted();

  const assistantItems: AssistantEventItem[] = [];
  let resultFallback: ResultEventItem | null = null;
  for (const event of events) {
    const sequenceNumber =
      event.sequenceNumber ?? event.eventData?.sequenceNumber;
    if (typeof sequenceNumber !== "number") {
      continue;
    }

    const assistant = extractAssistantContent(event);
    if (assistant !== null) {
      assistantItems.push({ sequenceNumber, content: assistant });
      continue;
    }

    const fallback = extractResultFallback(sequenceNumber, event);
    if (fallback !== null) {
      resultFallback = fallback;
    }
  }

  return { assistantItems, resultFallback };
}

async function latestEventBackedAssistantMessage(
  db: Db,
  runId: string,
): Promise<{ readonly content: string } | null> {
  const [message] = await db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.sequenceNumber),
      ),
    )
    .orderBy(desc(chatMessages.sequenceNumber))
    .limit(1);

  if (!message || message.content === null) {
    return null;
  }
  return { content: message.content };
}

async function recordLastEventToComplete(db: Db, runId: string): Promise<void> {
  const [run] = await db
    .select({ completedAt: agentRuns.completedAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run?.completedAt) {
    return;
  }

  const [message] = await db
    .select({
      lastEventAt: sql<Date | null>`MAX(${chatMessages.createdAt})`,
    })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.sequenceNumber),
      ),
    );
  if (!message?.lastEventAt) {
    return;
  }

  const lastEventMs =
    message.lastEventAt instanceof Date
      ? message.lastEventAt.getTime()
      : new Date(message.lastEventAt).getTime();
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "last_event_to_complete",
    durationMs: Math.max(0, run.completedAt.getTime() - lastEventMs),
    success: true,
    runId,
  });
}

async function insertAssistantErrorMessage(args: {
  readonly db: Db;
  readonly runId: string;
  readonly prompt: string;
  readonly threadId: string;
  readonly userId: string;
  readonly lifecycleEvent: "failed" | "cancelled";
  readonly getFormattedError: () => Promise<string>;
}): Promise<void> {
  const displayErrorMessage = await args.getFormattedError();
  await args.db
    .insert(chatMessages)
    .values({
      chatThreadId: args.threadId,
      role: "assistant",
      content: displayErrorMessage,
      runId: args.runId,
      error: displayErrorMessage,
      runLifecycleEvent: args.lifecycleEvent,
    })
    .onConflictDoNothing({
      target: chatMessages.runId,
      where: sql`${chatMessages.runLifecycleEvent} IS NOT NULL`,
    });
  await touchChatThreadLastMessageAt(args.db, args.threadId);

  await publishUserSignal(
    [args.userId],
    `chatThreadMessageCreated:${args.threadId}`,
  );
  await publishThreadListChanged(args.userId);
  await sendUserPushNotifications({
    db: args.db,
    userId: args.userId,
    notification: {
      title: args.prompt.slice(0, 60),
      body: `Task failed: ${displayErrorMessage.slice(0, 80)}`,
      url: `/chats/${args.threadId}`,
    },
  });
}

async function insertRunLifecycleMarker(args: {
  readonly db: Db;
  readonly runId: string;
  readonly threadId: string;
  readonly userId: string;
  readonly event: "completed" | "cancelled";
}): Promise<boolean> {
  const inserted = await args.db
    .insert(chatMessages)
    .values({
      chatThreadId: args.threadId,
      role: "assistant",
      content: null,
      runId: args.runId,
      runLifecycleEvent: args.event,
    })
    .onConflictDoNothing({
      target: chatMessages.runId,
      where: sql`${chatMessages.runLifecycleEvent} IS NOT NULL`,
    })
    .returning({ id: chatMessages.id });
  if (inserted.length === 0) {
    return false;
  }
  await touchChatThreadLastMessageAt(args.db, args.threadId);
  await publishUserSignal(
    [args.userId],
    `chatThreadMessageCreated:${args.threadId}`,
  );
  await publishThreadListChanged(args.userId);
  return true;
}

async function handleCompletedChatCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly signal: AbortSignal;
  readonly insertAssistantItems: (
    items: readonly AssistantEventItem[],
  ) => Promise<void>;
  readonly saveRunSummary: (resultText: string) => Promise<void>;
}): Promise<void> {
  const { assistantItems, resultFallback } = await queryChatOutputEvents({
    runId: args.runId,
    lastEventSequence: args.run.lastEventSequence,
    signal: args.signal,
  });
  args.signal.throwIfAborted();

  if (assistantItems.length > 0) {
    await args.insertAssistantItems(assistantItems);
    args.signal.throwIfAborted();
  }

  let lastResultText =
    assistantItems.length > 0
      ? assistantItems[assistantItems.length - 1]!.content
      : null;
  if (lastResultText === null) {
    const existingAssistant = await latestEventBackedAssistantMessage(
      args.db,
      args.runId,
    );
    args.signal.throwIfAborted();

    if (existingAssistant) {
      lastResultText = existingAssistant.content;
    } else if (resultFallback) {
      await args.insertAssistantItems([resultFallback]);
      args.signal.throwIfAborted();
      lastResultText = resultFallback.content;
    }
  }

  waitUntil(
    tapError(recordLastEventToComplete(args.db, args.runId), (error) => {
      log.warn("Failed to record last_event_to_complete", {
        runId: args.runId,
        error,
      });
    }),
  );

  await args.saveRunSummary(lastResultText ?? "");
  args.signal.throwIfAborted();

  await generateAndPersistChatThreadTitleFromCallback({
    db: args.db,
    threadId: args.chatThread.chatThreadId,
    userId: args.chatThread.userId,
    runId: args.runId,
    prompt: args.run.prompt,
    currentAssistantReply: lastResultText ?? undefined,
  });
  args.signal.throwIfAborted();

  await insertRunLifecycleMarker({
    db: args.db,
    runId: args.runId,
    threadId: args.chatThread.chatThreadId,
    userId: args.chatThread.userId,
    event: "completed",
  });
  args.signal.throwIfAborted();

  let summary: string | null = null;
  if (lastResultText) {
    const generated = await settle(
      generateChatNotificationSummary(args.run.prompt, lastResultText),
    );
    args.signal.throwIfAborted();
    if (generated.ok) {
      summary = generated.value;
    } else {
      log.warn("Failed to generate notification summary", {
        runId: args.runId,
        error: generated.error,
      });
    }
  }

  await sendUserPushNotifications({
    db: args.db,
    userId: args.chatThread.userId,
    notification: {
      title: args.run.prompt.slice(0, 60),
      body: summary ?? "Your task is complete",
      url: `/chats/${args.chatThread.chatThreadId}`,
    },
  });
}

async function handleFailedChatCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
  readonly errorMessage: string;
  readonly getFormattedError: () => Promise<string>;
}): Promise<void> {
  const lifecycleEvent =
    args.errorMessage.trim().toLowerCase() === "run cancelled"
      ? "cancelled"
      : "failed";
  await insertAssistantErrorMessage({
    db: args.db,
    runId: args.runId,
    prompt: args.run.prompt,
    threadId: args.chatThread.chatThreadId,
    userId: args.chatThread.userId,
    lifecycleEvent,
    getFormattedError: args.getFormattedError,
  });
}

function buildWebChatPrompt(): string {
  return [
    "# Current Integration\nYou are currently running inside: Web",
    "You are communicating with the user through the web chat UI.",
  ].join("\n\n");
}

function buildWebAttachFilesPrompt(
  files: readonly {
    readonly id: string;
    readonly filename: string;
    readonly contentType: string;
  }[],
): string {
  return files
    .map((file) => {
      return `[Web file] ${file.filename} (${file.contentType})\n   [ID] ${file.id}`;
    })
    .join("\n");
}

function buildAppendSystemPrompt(incompleteContext: string): string {
  return [buildWebChatPrompt(), incompleteContext]
    .filter((part) => {
      return part.length > 0;
    })
    .join("\n\n");
}

function formatAttachFileIds(
  ids: readonly string[] | null | undefined,
): string {
  if (!ids || ids.length === 0) {
    return "";
  }
  return ids
    .map((id) => {
      return `[Web file]\n   [ID] ${id}`;
    })
    .join("\n");
}

function truncateIncomplete(value: string): string {
  if (value.length <= INCOMPLETE_MESSAGE_CHAR_CAP) {
    return value;
  }
  return `${value.slice(0, INCOMPLETE_MESSAGE_CHAR_CAP)}...[truncated]`;
}

function formatIncompleteMessage(message: IncompleteRoundMessage): string {
  const attach = formatAttachFileIds(message.attachFiles);
  if (message.role === "user") {
    const body =
      message.content !== null && message.content !== ""
        ? truncateIncomplete(message.content)
        : "[empty message]";
    return attach ? `User: ${body}\n${attach}` : `User: ${body}`;
  }
  if (message.content !== null && message.content !== "") {
    return `Assistant (partial): ${truncateIncomplete(message.content)}`;
  }
  return "Assistant: [no response before run ended]";
}

function buildWebChatIncompleteContext(
  rounds: readonly IncompleteRound[],
): string {
  if (rounds.length === 0) {
    return "";
  }
  const total = rounds.length;
  const blocks = rounds.map((round, index) => {
    const relativeIndex = index - total + 1;
    const rendered = round.messages.map(formatIncompleteMessage);
    const hasAssistant = round.messages.some((message) => {
      return message.role === "assistant";
    });
    if (!hasAssistant) {
      rendered.push("Assistant: [no response before run ended]");
    }
    return [
      "---",
      "",
      `- RELATIVE_INDEX: ${relativeIndex}`,
      `- RUN_STATUS: ${round.status}`,
      "",
      ...rendered,
    ].join("\n");
  });
  return [
    "# Incomplete Rounds Context",
    "",
    "The rounds below were sent in this thread but their runs did not complete",
    "(cancelled, failed, or timed out), so the CLI session history does not",
    "contain them. Treat them as part of the conversation you are having with",
    "the user. RELATIVE_INDEX 0 is the most recent incomplete round.",
    "",
    blocks.join("\n\n"),
    "",
    "---",
  ].join("\n");
}

function isIncompleteRunStatus(
  value: string | null,
): value is "cancelled" | "failed" | "timeout" {
  return value === "cancelled" || value === "failed" || value === "timeout";
}

function groupIncompleteRoundsByRunId(
  rows: readonly IncompleteRoundRow[],
): readonly IncompleteRound[] {
  const byRunId = new Map<string, IncompleteRound>();
  const order: string[] = [];
  for (const row of rows) {
    let round = byRunId.get(row.runId);
    if (!round) {
      round = {
        runId: row.runId,
        status: row.runStatus,
        messages: [],
      };
      byRunId.set(row.runId, round);
      order.push(row.runId);
    }
    round.messages.push({
      role: row.role,
      content: row.content,
      error: row.error,
      attachFiles: row.attachFiles,
    });
  }
  return order.map((runId) => {
    const round = byRunId.get(runId);
    if (!round) {
      throw new Error("Incomplete round grouping lost run id");
    }
    return round;
  });
}

async function getIncompleteRoundsSinceLastSuccess(
  db: Db,
  threadId: string,
  maxRounds = 20,
): Promise<readonly IncompleteRoundRow[]> {
  const rows = await db
    .select({
      runId: chatMessages.runId,
      role: chatMessages.role,
      content: chatMessages.content,
      error: chatMessages.error,
      attachFiles: chatMessages.attachFiles,
      createdAt: chatMessages.createdAt,
      sequenceNumber: chatMessages.sequenceNumber,
      runStatus: agentRuns.status,
    })
    .from(chatMessages)
    .innerJoin(agentRuns, eq(agentRuns.id, chatMessages.runId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        visibleChatMessageCondition(),
        inArray(agentRuns.status, ["cancelled", "failed", "timeout"]),
        inArray(chatMessages.role, ["user", "assistant"]),
        sql`${chatMessages.createdAt} > COALESCE(
          (
            SELECT MAX(cm2.created_at)
            FROM chat_messages cm2
            INNER JOIN agent_runs ar2 ON ar2.id = cm2.run_id
            WHERE cm2.chat_thread_id = ${threadId}
              AND NOT EXISTS (
                SELECT 1
                FROM chat_messages revoker2
                WHERE revoker2.revokes_message_id = cm2.id
              )
              AND ar2.result ? 'agentSessionId'
              AND jsonb_typeof(ar2.result->'agentSessionId') = 'string'
          ),
          '-infinity'::timestamptz
        )`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.sequenceNumber));

  const candidates: IncompleteRoundRow[] = [];
  for (const row of rows) {
    if (row.runId === null || !isIncompleteRunStatus(row.runStatus)) {
      continue;
    }
    if (row.role !== "user" && row.role !== "assistant") {
      continue;
    }
    candidates.push({
      runId: row.runId,
      runStatus: row.runStatus,
      role: row.role,
      content: row.content,
      error: row.error,
      attachFiles: row.attachFiles,
    });
  }

  const orderedRunIds: string[] = [];
  const seen = new Set<string>();
  for (const row of candidates) {
    if (!seen.has(row.runId)) {
      seen.add(row.runId);
      orderedRunIds.push(row.runId);
    }
  }
  if (orderedRunIds.length <= maxRounds) {
    return candidates;
  }

  const keep = new Set(orderedRunIds.slice(orderedRunIds.length - maxRounds));
  return candidates.filter((row) => {
    return keep.has(row.runId);
  });
}

async function nextQueuedUserMessage(
  db: Db,
  threadId: string,
): Promise<QueuedUserMessage | null> {
  const [message] = await db
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      attachFiles: chatMessages.attachFiles,
      attachFileMetadata: chatMessages.attachFileMetadata,
      modelProviderId: sql<null>`NULL`,
      modelProviderType: sql<null>`NULL`,
      modelProviderCredentialScope: sql<null>`NULL`,
      selectedModel: chatThreads.selectedModel,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        eq(chatMessages.role, "user"),
        isNull(chatMessages.runId),
        isNull(chatMessages.revokesMessageId),
        isNull(chatMessages.interruptsRunId),
        sql`NOT EXISTS (
          SELECT 1
          FROM ${chatMessages} AS revoker
          WHERE revoker.revokes_message_id = ${chatMessages.id}
        )`,
      ),
    )
    .orderBy(asc(chatMessages.createdAt), asc(chatMessages.id))
    .limit(1);

  return message ?? null;
}

async function resolveQueuedMessageModelPin(params: {
  readonly db: Db;
  readonly orgId: string;
  readonly queuedMessage: QueuedUserMessage;
}): Promise<QueuedUserMessage> {
  if (!params.queuedMessage.selectedModel) {
    return params.queuedMessage;
  }

  const [policy] = await params.db
    .select({
      model: orgModelPolicies.model,
      defaultProviderType: orgModelPolicies.defaultProviderType,
      credentialScope: orgModelPolicies.credentialScope,
      modelProviderId: orgModelPolicies.modelProviderId,
    })
    .from(orgModelPolicies)
    .where(
      and(
        eq(orgModelPolicies.orgId, params.orgId),
        eq(orgModelPolicies.model, params.queuedMessage.selectedModel),
      ),
    )
    .limit(1);

  if (!policy) {
    return params.queuedMessage;
  }

  return {
    ...params.queuedMessage,
    modelProviderId: policy.modelProviderId ?? null,
    modelProviderType: policy.defaultProviderType,
    modelProviderCredentialScope: parseModelProviderCredentialScope(
      policy.credentialScope,
    ),
    selectedModel: policy.model,
  };
}

async function chatThreadForRunFromDb(
  db: Db,
  runId: string,
): Promise<ChatThreadForRunRow | null> {
  const [row] = await db
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(zeroRuns)
    .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);

  if (!row?.chatThreadId) {
    return null;
  }
  return { chatThreadId: row.chatThreadId, userId: row.userId };
}

function hasAgentSessionId(
  value: unknown,
): value is { readonly agentSessionId: string } {
  return (
    typeof value === "object" &&
    value !== null &&
    "agentSessionId" in value &&
    typeof (value as { readonly agentSessionId: unknown }).agentSessionId ===
      "string"
  );
}

async function latestSessionIdForThreadFromDb(
  db: Db,
  threadId: string,
): Promise<string | null> {
  const rows = await db
    .select({ result: agentRuns.result })
    .from(zeroRuns)
    .innerJoin(agentRuns, eq(zeroRuns.id, agentRuns.id))
    .where(eq(zeroRuns.chatThreadId, threadId))
    .orderBy(desc(agentRuns.createdAt))
    .limit(5);

  for (const row of rows) {
    if (hasAgentSessionId(row.result)) {
      return row.result.agentSessionId;
    }
  }
  return null;
}

async function loadAgentForAutoSend(
  db: Db,
  agentId: string,
): Promise<AgentForAutoSend | null> {
  const [agent] = await db
    .select({ id: zeroAgents.id, orgId: zeroAgents.orgId })
    .from(zeroAgents)
    .where(eq(zeroAgents.id, agentId))
    .limit(1);
  return agent ?? null;
}

function fallbackAttachFiles(ids: readonly string[] | null): readonly {
  readonly id: string;
  readonly filename: string;
  readonly contentType: string;
  readonly size: number;
  readonly url: string;
}[] {
  return (ids ?? []).map((id) => {
    return {
      id,
      filename: id,
      contentType: "application/octet-stream",
      size: 0,
      url: "",
    };
  });
}

async function autoSendQueuedMessageOnRunComplete(args: {
  readonly getResolvedAttachFiles: (
    userId: string,
    fileIds: readonly string[],
  ) => Promise<
    readonly {
      readonly id: string;
      readonly filename: string;
      readonly contentType: string;
      readonly size: number;
      readonly url: string;
    }[]
  >;
  readonly createRun: (
    input: CreateQueuedChatRunInput,
  ) => Promise<{ readonly runId: string } | null>;
  readonly db: Db;
  readonly runId: string;
  readonly agentId: string;
}): Promise<void> {
  const chatThread = await chatThreadForRunFromDb(args.db, args.runId);
  if (!chatThread) {
    return;
  }
  const { chatThreadId: threadId, userId } = chatThread;

  const queuedMessage = await nextQueuedUserMessage(args.db, threadId);
  if (!queuedMessage) {
    return;
  }

  const agent = await loadAgentForAutoSend(args.db, args.agentId);
  if (!agent) {
    log.warn("Auto-send aborted: agent not found", {
      threadId,
      agentId: args.agentId,
    });
    return;
  }
  const resolvedQueuedMessage = await resolveQueuedMessageModelPin({
    db: args.db,
    orgId: agent.orgId,
    queuedMessage,
  });

  const [sessionId, incompleteRows] = await Promise.all([
    latestSessionIdForThreadFromDb(args.db, threadId),
    getIncompleteRoundsSinceLastSuccess(args.db, threadId),
  ]);
  const incompleteContext = buildWebChatIncompleteContext(
    groupIncompleteRoundsByRunId(incompleteRows),
  );

  const resolvedAttachFiles =
    resolvedQueuedMessage.attachFileMetadata &&
    resolvedQueuedMessage.attachFileMetadata.length > 0
      ? resolveAttachFileMetadataUrls(resolvedQueuedMessage.attachFileMetadata)
      : resolvedQueuedMessage.attachFiles &&
          resolvedQueuedMessage.attachFiles.length > 0
        ? await args.getResolvedAttachFiles(
            userId,
            resolvedQueuedMessage.attachFiles,
          )
        : [];
  const attachFiles =
    resolvedAttachFiles.length > 0
      ? resolvedAttachFiles
      : fallbackAttachFiles(resolvedQueuedMessage.attachFiles);
  const content = resolvedQueuedMessage.content ?? "";
  const fullPrompt =
    attachFiles.length === 0
      ? content
      : `${content}\n\n${buildWebAttachFilesPrompt(attachFiles)}`;

  const run = await args.createRun({
    orgId: agent.orgId,
    userId,
    agentId: agent.id,
    prompt: fullPrompt,
    sessionId,
    appendSystemPrompt: buildAppendSystemPrompt(incompleteContext),
    threadId,
    queuedMessage: resolvedQueuedMessage,
  });
  if (!run) {
    return;
  }

  const claimed = await args.db
    .insert(chatMessages)
    .values({
      chatThreadId: threadId,
      role: "user",
      content: queuedMessage.content,
      runId: run.runId,
      attachFiles: queuedMessage.attachFiles
        ? [...queuedMessage.attachFiles]
        : null,
      attachFileMetadata: queuedMessage.attachFileMetadata
        ? [...queuedMessage.attachFileMetadata]
        : null,
      revokesMessageId: queuedMessage.id,
    })
    .onConflictDoNothing({ target: chatMessages.revokesMessageId })
    .returning({ id: chatMessages.id });

  if (claimed.length === 0) {
    await args.db
      .update(agentRuns)
      .set({ status: "cancelled", error: "Queued message already claimed" })
      .where(eq(agentRuns.id, run.runId));
    log.warn("Auto-send created a run for an already-claimed message", {
      threadId,
      runId: run.runId,
      userMessageId: queuedMessage.id,
    });
    return;
  }

  await touchChatThreadLastMessageAt(args.db, threadId);

  await publishUserSignal([userId], `chatThreadMessageCreated:${threadId}`);
  await publishUserSignal([userId], `chatThreadRunCreated:${threadId}`);
  await publishThreadListChanged(userId);
}

async function createQueuedChatRun(args: {
  readonly db: Db;
  readonly input: CreateQueuedChatRunInput;
  readonly signal: AbortSignal;
  readonly createRun: (
    input: CreateQueuedChatRunInput,
  ) => Promise<{ readonly runId: string } | null>;
}): Promise<{ readonly runId: string } | null> {
  const created = await args.createRun(args.input);
  args.signal.throwIfAborted();
  if (!created) {
    return null;
  }

  await args.db
    .update(zeroRuns)
    .set({
      modelProvider: args.input.queuedMessage.modelProviderType,
      modelProviderId: args.input.queuedMessage.modelProviderId,
      modelProviderCredentialScope:
        args.input.queuedMessage.modelProviderCredentialScope,
      selectedModel: args.input.queuedMessage.selectedModel,
    })
    .where(eq(zeroRuns.id, created.runId));
  args.signal.throwIfAborted();

  return created;
}

async function loadTerminalChatCallback(args: {
  readonly db: Db;
  readonly runId: string;
  readonly callbackStatus: "completed" | "failed";
  readonly payloadThreadId: string;
  readonly signal: AbortSignal;
}): Promise<{
  readonly run: ChatRunInfo;
  readonly chatThread: ChatThreadForRunRow;
} | null> {
  const [run] = await args.db
    .select({
      prompt: agentRuns.prompt,
      error: agentRuns.error,
      lastEventSequence: agentRuns.lastEventSequence,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, args.runId))
    .limit(1);
  args.signal.throwIfAborted();

  if (!run) {
    return null;
  }

  const chatThread = await chatThreadForRunFromDb(args.db, args.runId);
  args.signal.throwIfAborted();
  if (!chatThread) {
    log.debug("Skipping terminal chat callback for missing chat thread", {
      runId: args.runId,
      status: args.callbackStatus,
      payloadThreadId: args.payloadThreadId,
    });
    return null;
  }

  if (chatThread.chatThreadId !== args.payloadThreadId) {
    log.warn("Chat callback payload thread does not match run mapping", {
      runId: args.runId,
      payloadThreadId: args.payloadThreadId,
      chatThreadId: chatThread.chatThreadId,
    });
  }

  return { run, chatThread };
}

const handleChatCallback$ = command(
  async ({ get, set }, signal: AbortSignal) => {
    const apiStartTime = now();
    const callback = get(callbackPayload$);
    const payload = chatCallbackPayloadSchema.safeParse(callback.payload);
    if (!payload.success) {
      return {
        status: 400 as const,
        body: { error: "Invalid or missing payload" },
      };
    }

    if (callback.status === "progress") {
      return { status: 200 as const, body: { success: true as const } };
    }

    const db = set(writeDb$);
    const loaded = await loadTerminalChatCallback({
      db,
      runId: callback.runId,
      callbackStatus: callback.status,
      payloadThreadId: payload.data.threadId,
      signal,
    });
    if (!loaded) {
      return { status: 200 as const, body: { success: true as const } };
    }
    const { run, chatThread } = loaded;

    if (callback.status === "completed") {
      await handleCompletedChatCallback({
        db,
        runId: callback.runId,
        run,
        chatThread,
        signal,
        insertAssistantItems: async (items) => {
          await set(
            insertAssistantEventMessages$,
            {
              runId: callback.runId,
              threadId: chatThread.chatThreadId,
              userId: chatThread.userId,
              items,
            },
            signal,
          );
        },
        saveRunSummary: (resultText) => {
          return set(
            saveRunSummary$,
            {
              runId: callback.runId,
              triggerSource: "chat",
              prompt: run.prompt,
              resultText,
            },
            signal,
          );
        },
      });
      signal.throwIfAborted();
    } else if (callback.status === "failed") {
      const errorMessage = callback.error ?? run.error ?? "Run failed";
      await handleFailedChatCallback({
        db,
        runId: callback.runId,
        run,
        chatThread,
        errorMessage,
        getFormattedError: () => {
          return get(
            formatChatRunErrorMessage({
              chatThreadId: chatThread.chatThreadId,
              runId: callback.runId,
              errorMessage,
            }),
          );
        },
      });
      signal.throwIfAborted();
    }

    await autoSendQueuedMessageOnRunComplete({
      db,
      runId: callback.runId,
      agentId: payload.data.agentId,
      getResolvedAttachFiles: (userId, fileIds) => {
        return get(resolveAttachFileUrls(userId, fileIds));
      },
      createRun: (input) => {
        return createQueuedChatRun({
          db,
          input,
          signal,
          createRun: async (runInput) => {
            const runResult = await set(
              createZeroRun$,
              buildQueuedCreateZeroRunArgs(runInput, apiStartTime),
              signal,
            );
            if (runResult.status !== 201) {
              log.warn("Auto-send failed to create run", {
                threadId: runInput.threadId,
                status: runResult.status,
              });
              return null;
            }
            return { runId: runResult.body.runId };
          },
        });
      },
    });
    signal.throwIfAborted();

    return { status: 200 as const, body: { success: true as const } };
  },
);

export const internalCallbacksChatRoutes: readonly RouteEntry[] = [
  {
    route: internalCallbacksChatContract.post,
    handler: callbackRoute(handleChatCallback$),
  },
];
