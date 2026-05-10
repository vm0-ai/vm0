import { NextRequest, NextResponse, after } from "next/server";
import { and, desc, eq, isNotNull, sql } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { recordSandboxOperation } from "../../../../../src/lib/infra/metrics/instruments";
import {
  insertChatMessage,
  insertAssistantEventMessages,
  publishChatThreadRunUpdated,
  getLatestMessagesByThreadId,
  getChatThreadIdForRun,
  PREVIOUS_CONTEXT_MESSAGES,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
import { autoSendQueuedMessageOnRunComplete } from "../../../../../src/lib/zero/chat-thread/auto-send-queued-message";
import { formatChatRunErrorMessage } from "../../../../../src/lib/zero/chat-thread/chat-run-error-message";
import {
  generateChatTitle,
  generateChatNotificationSummary,
  type TitleContextMessage,
} from "../../../../../src/lib/zero/ai/lightweight-model";
import { updateChatThreadTitle } from "../../../../../src/lib/zero/chat-thread";
import { sendUserPushNotifications } from "../../../../../src/lib/push/send-push";
import { saveRunSummary } from "../../../../../src/lib/zero/run-summary";
import {
  queryAxiom,
  flushAxiom,
  getDatasetName,
  DATASETS,
  escapeAplString,
} from "../../../../../src/lib/shared/axiom";
import { waitForRunEventWatermarkVisible } from "../../../../../src/lib/infra/run/agent-event-visibility";
import type { ChatCallbackPayload } from "../../../../../src/lib/infra/callback/callback-payloads";
import { logger } from "../../../../../src/lib/shared/logger";

const log = logger("callback:chat");

function parsePayload(payload: unknown): ChatCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.threadId !== "string" || typeof p.agentId !== "string") {
    return null;
  }
  return { threadId: p.threadId, agentId: p.agentId };
}

interface ContentBlock {
  type: string;
  text?: string;
}

interface CodexItem {
  type?: string;
  text?: string;
}

interface AxiomChatOutputEvent {
  eventType?: string;
  sequenceNumber?: number;
  eventData?: {
    message?: { content?: ContentBlock[] };
    item?: CodexItem;
    result?: string;
    sequenceNumber?: number;
  };
}

interface AssistantEventItem {
  sequenceNumber: number;
  content: string;
}

interface ResultEventItem {
  sequenceNumber: number;
  content: string;
}

/**
 * Query Axiom for terminal chat output. Assistant events remain the primary
 * source; a result event is kept only as a fallback for result-only CLI
 * outputs such as Claude Code slash-command messages.
 */
async function queryChatOutputEvents(
  runId: string,
  lastEventSequence: number | null,
): Promise<{
  assistantItems: AssistantEventItem[];
  resultFallback: ResultEventItem | null;
}> {
  await waitForRunEventWatermarkVisible(runId, lastEventSequence);

  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${escapeAplString(runId)}"
| where eventType == "assistant" or eventType == "result" or eventType == "item.completed"
| order by sequenceNumber asc
| limit 200`;

  const events = await queryAxiom<AxiomChatOutputEvent>(apl, {
    noCache: true,
  });

  const assistantItems: AssistantEventItem[] = [];
  let resultFallback: ResultEventItem | null = null;
  for (const e of events) {
    const seq = e.sequenceNumber ?? e.eventData?.sequenceNumber;
    if (typeof seq !== "number") continue;

    const assistant = extractAssistantContent(e);
    if (assistant !== null) {
      assistantItems.push({ sequenceNumber: seq, content: assistant });
      continue;
    }

    const fallback = extractResultFallback(seq, e);
    if (fallback !== null) {
      resultFallback = fallback;
    }
  }
  return { assistantItems, resultFallback };
}

function extractAnthropicContent(blocks: ContentBlock[]): string | null {
  const parts: string[] = [];
  for (const block of blocks) {
    if (block.type === "text" && typeof block.text === "string") {
      parts.push(block.text);
    }
  }
  if (parts.length === 0) return null;
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

function extractAssistantContent(e: AxiomChatOutputEvent): string | null {
  const content = e.eventData?.message?.content;
  if (content) {
    return extractAnthropicContent(content);
  }
  const item = e.eventData?.item;
  if (item) {
    return extractCodexAgentMessageContent(item);
  }
  return null;
}

function extractResultFallback(
  seq: number,
  e: AxiomChatOutputEvent,
): ResultEventItem | null {
  const result = e.eventData?.result;
  if (typeof result !== "string") return null;
  const trimmed = result.trim();
  if (!trimmed) return null;
  return { sequenceNumber: seq, content: result };
}

async function latestEventBackedAssistantMessage(
  runId: string,
): Promise<{ content: string } | null> {
  const [message] = await globalThis.services.db
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

/**
 * Load the prior conversation turns to feed into title generation, excluding
 * the current exchange (this run's user message and assistant events).
 * Returns up to the last 10 messages (~5 rounds), oldest → newest.
 *
 * All filters (content not null, role user/assistant, exclude current run)
 * run in SQL so the scan is bounded by `LIMIT N` even on long threads.
 */
async function loadPriorTitleContext(
  threadId: string,
  currentRunId: string,
): Promise<TitleContextMessage[]> {
  const messages = await getLatestMessagesByThreadId(
    threadId,
    PREVIOUS_CONTEXT_MESSAGES,
    { excludeRunId: currentRunId },
  );
  return messages.map((m) => {
    return { role: m.role, content: m.content };
  });
}

/**
 * Emit the `last_event_to_complete` metric for Morning Brief wrap-up
 * aggregation. Filters on `sequence_number IS NOT NULL` to exclude user
 * messages and placeholder/error rows, keeping the metric grounded in
 * real agent output.
 */
async function recordLastEventToComplete(runId: string): Promise<void> {
  const [run] = await globalThis.services.db
    .select({ completedAt: agentRuns.completedAt })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);
  if (!run?.completedAt) return;

  const [msg] = await globalThis.services.db
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
  if (!msg?.lastEventAt) return;

  const lastEventMs =
    msg.lastEventAt instanceof Date
      ? msg.lastEventAt.getTime()
      : new Date(msg.lastEventAt).getTime();
  recordSandboxOperation({
    sandboxType: "runner",
    actionType: "last_event_to_complete",
    durationMs: Math.max(0, run.completedAt.getTime() - lastEventMs),
    success: true,
    runId,
  });
  // after() runs post-response; this route isn't a ts-rest handler, so the
  // response-boundary flush doesn't cover it. Without an explicit flush,
  // Vercel freezes the lambda before the Axiom SDK's batch timer fires and
  // the sample is dropped. Same pattern as event-consumers/axiom/route.ts.
  await flushAxiom();
}

/**
 * Handle completed run: final sweep for any events the consumer missed,
 * then generate title and push notification.
 */
async function handleCompleted(
  runId: string,
  prompt: string,
  threadId: string,
  userId: string,
  lastEventSequence: number | null,
): Promise<void> {
  // Final sweep: re-query Axiom and insert any assistant output the live
  // consumer missed. Result-only CLI output is inserted only when no assistant
  // output exists for the run. Inserts are idempotent via the
  // `(run_id, sequence_number)` unique index, so concurrent writes from the
  // consumer and this sweep cannot produce duplicates.
  const { assistantItems, resultFallback } = await queryChatOutputEvents(
    runId,
    lastEventSequence,
  );
  if (assistantItems.length > 0) {
    await insertAssistantEventMessages(runId, threadId, userId, assistantItems);
  }

  let lastResultText =
    assistantItems.length > 0
      ? assistantItems[assistantItems.length - 1]!.content
      : null;
  if (lastResultText === null) {
    const existingAssistant = await latestEventBackedAssistantMessage(runId);
    if (existingAssistant) {
      lastResultText = existingAssistant.content;
    } else if (resultFallback) {
      await insertAssistantEventMessages(runId, threadId, userId, [
        resultFallback,
      ]);
      lastResultText = resultFallback.content;
    }
  }

  // Wrap-up latency: gap from last assistant event row to run terminal
  // transition. Scheduled via after() so the DB query and Axiom ingest
  // don't block the callback response. Runs after the final sweep above
  // so it isn't racing events the live consumer dropped.
  after(() => {
    return recordLastEventToComplete(runId);
  });

  // Generate run summary (best-effort — errors handled internally)
  await saveRunSummary(runId, "chat", prompt, lastResultText ?? "");

  // Generate and update chat thread title (best-effort — title is non-critical).
  // Pass prior rounds in addition to the current exchange so the title stays
  // consistent across the thread instead of flipping each turn.
  try {
    const priorRounds = await loadPriorTitleContext(threadId, runId);
    const title = await generateChatTitle({
      currentUserMessage: prompt,
      currentAssistantReply: lastResultText ?? undefined,
      priorRounds: priorRounds.length > 0 ? priorRounds : undefined,
    });
    if (title) {
      await updateChatThreadTitle(threadId, userId, title);
    }
  } catch (err) {
    log.warn("Failed to generate chat title", { err });
  }

  // Send push notification (best-effort)
  let summary: string | null = null;
  try {
    summary = lastResultText
      ? await generateChatNotificationSummary(prompt, lastResultText)
      : null;
  } catch (err) {
    log.warn("Failed to generate notification summary", { err });
  }
  await sendUserPushNotifications(userId, {
    title: prompt.slice(0, 60),
    body: summary ?? "Your task is complete",
    url: `/chats/${threadId}`,
  });
}

/**
 * Handle failed run: insert an error message row for the assistant.
 */
async function handleFailed(
  runId: string,
  prompt: string,
  threadId: string,
  userId: string,
  errorMessage: string,
): Promise<void> {
  const displayErrorMessage = await formatChatRunErrorMessage({
    chatThreadId: threadId,
    runId,
    errorMessage,
  });

  await insertChatMessage({
    chatThreadId: threadId,
    userId,
    role: "assistant",
    content: displayErrorMessage,
    runId,
    error: displayErrorMessage,
  });

  // Send push notification (best-effort)
  await sendUserPushNotifications(userId, {
    title: prompt.slice(0, 60),
    body: `Task failed: ${displayErrorMessage.slice(0, 80)}`,
    url: `/chats/${threadId}`,
  });
}

/**
 * POST /api/internal/callbacks/chat
 *
 * Chat callback handler for agent run completion.
 * Final sweep: inserts any assistant output not yet written by the
 * chat-assistant consumer, or terminal result-only output when there is no
 * assistant output, then generates title and sends push notification.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();
  const apiStartTime = Date.now();

  const result = await verifyCallback<ChatCallbackPayload>(request, log);
  if (!result.ok) return result.response;

  const { runId, status, error } = result.data;
  const payload = parsePayload(result.data.payload);
  if (!payload) {
    return NextResponse.json(
      { error: "Invalid or missing payload" },
      { status: 400 },
    );
  }

  // Progress: no-op
  if (status === "progress") {
    return NextResponse.json({ success: true });
  }

  // Fetch the run record for prompt and terminal error details.
  const [run] = await globalThis.services.db
    .select({
      prompt: agentRuns.prompt,
      error: agentRuns.error,
      lastEventSequence: agentRuns.lastEventSequence,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    return NextResponse.json({ success: true });
  }

  const chatThread = await getChatThreadIdForRun(runId);
  if (!chatThread) {
    log.info("Skipping terminal chat callback for missing chat thread", {
      runId,
      status,
      payloadThreadId: payload.threadId,
    });
    return NextResponse.json({ success: true });
  }

  if (chatThread.chatThreadId !== payload.threadId) {
    log.warn("Chat callback payload thread does not match run mapping", {
      runId,
      payloadThreadId: payload.threadId,
      chatThreadId: chatThread.chatThreadId,
    });
  }

  if (status === "completed") {
    await handleCompleted(
      runId,
      run.prompt,
      chatThread.chatThreadId,
      chatThread.userId,
      run.lastEventSequence,
    );
  } else if (status === "failed") {
    const errorMessage = error ?? run.error ?? "Run failed";
    await handleFailed(
      runId,
      run.prompt,
      chatThread.chatThreadId,
      chatThread.userId,
      errorMessage,
    );
  }

  // Notify chat subscribers that the run transitioned to a terminal state.
  // Fires once per terminal callback (completed / failed — cancel maps to
  // failed via dispatchTerminalSideEffects), covering the case where no
  // assistant row was written yet.
  await publishChatThreadRunUpdated(runId);

  // Auto-send a queued pending message as the next round. No-op when the
  // user hasn't queued anything; otherwise this clears the pending columns
  // and dispatches a fresh run, mirroring the user's "send next" intent
  // without requiring an open browser tab.
  await autoSendQueuedMessageOnRunComplete({
    runId,
    agentId: payload.agentId,
    apiStartTime,
    terminalStatus: status === "completed" ? "completed" : "failed",
  });

  return NextResponse.json({ success: true });
}
