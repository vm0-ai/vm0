import { NextRequest, NextResponse, after } from "next/server";
import { and, eq, isNotNull, sql } from "drizzle-orm";
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
  PREVIOUS_CONTEXT_MESSAGES,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
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
} from "../../../../../src/lib/shared/axiom";
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

interface AxiomAssistantEvent {
  sequenceNumber?: number;
  eventData?: {
    message?: { content?: ContentBlock[] };
    sequenceNumber?: number;
  };
}

/**
 * Query Axiom for every assistant event for this run and flatten them into
 * `(sequenceNumber, content)` pairs. Used as the final sweep to backfill any
 * events the live consumer dropped.
 */
async function queryAssistantEvents(
  runId: string,
): Promise<{ sequenceNumber: number; content: string }[]> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| where eventType == "assistant"
| order by sequenceNumber asc
| limit 200`;

  const events = await queryAxiom<AxiomAssistantEvent>(apl);

  const items: { sequenceNumber: number; content: string }[] = [];
  for (const e of events) {
    const seq = e.sequenceNumber ?? e.eventData?.sequenceNumber;
    if (typeof seq !== "number") continue;
    const content = e.eventData?.message?.content;
    if (!content) continue;
    const parts: string[] = [];
    for (const block of content) {
      if (block.type === "text" && typeof block.text === "string") {
        parts.push(block.text);
      }
    }
    if (parts.length === 0) continue;
    items.push({
      sequenceNumber: seq,
      content: parts.length === 1 ? parts[0]! : parts.join("\n\n"),
    });
  }
  return items;
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
): Promise<void> {
  // Final sweep: re-query Axiom and insert any events the live consumer
  // missed. Inserts are idempotent via the `(run_id, sequence_number)`
  // unique index, so concurrent writes from the consumer and this sweep
  // cannot produce duplicates.
  const items = await queryAssistantEvents(runId);
  if (items.length > 0) {
    await insertAssistantEventMessages(runId, threadId, userId, items);
  }

  // Wrap-up latency: gap from last assistant event row to run terminal
  // transition. Scheduled via after() so the DB query and Axiom ingest
  // don't block the callback response. Runs after the final sweep above
  // so it isn't racing events the live consumer dropped.
  after(() => {
    return recordLastEventToComplete(runId);
  });

  // Use last assistant text for downstream (title, summary, notification)
  const lastResultText =
    items.length > 0 ? items[items.length - 1]!.content : null;

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
 * Final sweep: inserts any assistant events not yet written by the
 * chat-assistant consumer (via `ON CONFLICT DO NOTHING`), then generates
 * title and sends push notification.
 */
export async function POST(request: NextRequest): Promise<NextResponse> {
  initServices();

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

  // Fetch the run record for userId, prompt, error
  const [run] = await globalThis.services.db
    .select({
      userId: agentRuns.userId,
      prompt: agentRuns.prompt,
      error: agentRuns.error,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    return NextResponse.json({ success: true });
  }

  if (status === "completed") {
    await handleCompleted(runId, run.prompt, payload.threadId, run.userId);
  } else if (status === "failed") {
    const errorMessage = error ?? run.error ?? "Run failed";
    await handleFailed(
      runId,
      run.prompt,
      payload.threadId,
      run.userId,
      errorMessage,
    );
  }

  // Notify chat subscribers that the run transitioned to a terminal state.
  // Fires once per terminal callback (completed / failed — cancel maps to
  // failed via dispatchTerminalSideEffects), covering the case where no
  // assistant row was written yet.
  await publishChatThreadRunUpdated(runId);

  return NextResponse.json({ success: true });
}
