import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/infra/callback";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import {
  updateAssistantMessageByRunId,
  insertAssistantEventMessages,
  getChatThreadIdForRun,
  cleanupAssistantPlaceholderIfEventsExist,
} from "../../../../../src/lib/zero/chat-thread/chat-message-service";
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
 * Handle completed run: final sweep for any events the consumer missed,
 * drop the placeholder, then generate title and push notification.
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
    const chatThreadId = (await getChatThreadIdForRun(runId)) ?? threadId;
    await insertAssistantEventMessages(runId, chatThreadId, items);
  }

  // If any event-backed rows landed, retire the placeholder so the UI
  // doesn't render an empty assistant bubble alongside the real ones.
  await cleanupAssistantPlaceholderIfEventsExist(runId);

  // Use last assistant text for downstream (title, summary, notification)
  const lastResultText =
    items.length > 0 ? items[items.length - 1]!.content : null;

  // Generate run summary (best-effort — errors handled internally)
  await saveRunSummary(runId, "chat", prompt, lastResultText ?? "");

  // Generate and update chat thread title (best-effort — title is non-critical)
  try {
    const previousMessages: TitleContextMessage[] = lastResultText
      ? [{ role: "assistant", content: lastResultText }]
      : [];
    const title = await generateChatTitle(
      prompt,
      previousMessages.length > 0 ? previousMessages : undefined,
    );
    if (title) {
      await updateChatThreadTitle(threadId, title);
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
 * Handle failed run: update assistant placeholder with the error message.
 */
async function handleFailed(
  runId: string,
  prompt: string,
  threadId: string,
  userId: string,
  errorMessage: string,
): Promise<void> {
  // Update the assistant placeholder (sequence_number IS NULL) with error.
  await updateAssistantMessageByRunId(runId, errorMessage, errorMessage);

  // Send push notification (best-effort)
  await sendUserPushNotifications(userId, {
    title: prompt.slice(0, 60),
    body: `Task failed: ${errorMessage.slice(0, 80)}`,
    url: `/chats/${threadId}`,
  });
}

/**
 * POST /api/internal/callbacks/chat
 *
 * Chat callback handler for agent run completion.
 * Final sweep: inserts any assistant events not yet written by the
 * chat-assistant consumer (via `ON CONFLICT DO NOTHING`), cleans up the
 * placeholder, then generates title and sends push notification.
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

  return NextResponse.json({ success: true });
}
