import { NextRequest, NextResponse } from "next/server";
import { eq } from "drizzle-orm";
import type { SummaryEntry } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { verifyCallback } from "../../../../../src/lib/callback";
import { chatThreads } from "../../../../../src/db/schema/chat-thread";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { findNewSessionId } from "../../../../../src/lib/session/find-new-session";
import { queryRunEventsForChat } from "../../../../../src/lib/run/extract-chat-events";
import { appendChatMessages } from "../../../../../src/lib/zero/zero-session-service";
import {
  generateChatTitle,
  type TitleContextMessage,
} from "../../../../../src/lib/ai/lightweight-model";
import { updateChatThreadTitle } from "../../../../../src/lib/chat-thread";
import type { ChatCallbackPayload } from "../../../../../src/lib/callback/callback-payloads";
import { logger } from "../../../../../src/lib/logger";

const log = logger("callback:chat");

function parsePayload(payload: unknown): ChatCallbackPayload | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as Record<string, unknown>;
  if (typeof p.threadId !== "string" || typeof p.agentId !== "string") {
    return null;
  }
  return { threadId: p.threadId, agentId: p.agentId };
}

/**
 * Persist chat messages to the session and update thread sessionId if needed.
 */
async function persistMessages(
  sessionId: string,
  userId: string,
  messages: Array<{
    role: "user" | "assistant";
    content: string;
    runId?: string;
    summaries?: SummaryEntry[];
  }>,
  runId: string,
): Promise<void> {
  await appendChatMessages(sessionId, userId, messages);
  log.debug(`Persisted ${messages.length} chat messages for run ${runId}`);
}

/**
 * Update sessionId on thread if not already set.
 */
async function updateThreadSessionId(
  threadId: string,
  sessionId: string,
): Promise<void> {
  const [thread] = await globalThis.services.db
    .select({ sessionId: chatThreads.sessionId })
    .from(chatThreads)
    .where(eq(chatThreads.id, threadId))
    .limit(1);

  if (thread && !thread.sessionId) {
    await globalThis.services.db
      .update(chatThreads)
      .set({ sessionId })
      .where(eq(chatThreads.id, threadId));
  }
}

/**
 * Handle completed run: persist messages with summaries, update sessionId, generate title.
 */
async function handleCompleted(
  runId: string,
  sessionId: string | undefined,
  userId: string,
  prompt: string,
  threadId: string,
): Promise<void> {
  // Query Axiom for result text and summaries
  const { resultText, summaries } = await queryRunEventsForChat(runId);

  // Persist chat messages to session
  if (sessionId) {
    const messages: Array<{
      role: "user" | "assistant";
      content: string;
      runId?: string;
      summaries?: SummaryEntry[];
    }> = [{ role: "user", content: prompt }];

    if (resultText) {
      messages.push({
        role: "assistant",
        content: resultText,
        runId,
        ...(summaries.length > 0 ? { summaries } : {}),
      });
    }

    await persistMessages(sessionId, userId, messages, runId);
    await updateThreadSessionId(threadId, sessionId);
  }

  // Generate and update chat thread title (best-effort — title is non-critical)
  try {
    const previousMessages: TitleContextMessage[] = resultText
      ? [{ role: "assistant", content: resultText }]
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
}

/**
 * Handle failed run: persist error messages, update sessionId.
 */
async function handleFailed(
  runId: string,
  sessionId: string | undefined,
  userId: string,
  prompt: string,
  threadId: string,
  errorMessage: string,
): Promise<void> {
  if (sessionId) {
    await persistMessages(
      sessionId,
      userId,
      [
        { role: "user", content: prompt },
        { role: "assistant", content: errorMessage, runId },
      ],
      runId,
    );
    await updateThreadSessionId(threadId, sessionId);
  }
}

/**
 * POST /api/internal/callbacks/chat
 *
 * Chat callback handler for agent run completion.
 * Handles the full chat completion flow:
 * - Persists user + assistant messages (with summaries) to the session
 * - Sets sessionId on the chat thread
 * - Generates and updates the chat thread title (on completion only)
 * - Persists error messages on failure
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

  // Fetch the run record for userId, prompt, createdAt, error
  const [run] = await globalThis.services.db
    .select({
      userId: agentRuns.userId,
      prompt: agentRuns.prompt,
      createdAt: agentRuns.createdAt,
      error: agentRuns.error,
    })
    .from(agentRuns)
    .where(eq(agentRuns.id, runId))
    .limit(1);

  if (!run) {
    return NextResponse.json({ success: true });
  }

  // Resolve session for message persistence
  const sessionId = await findNewSessionId(
    run.userId,
    payload.agentId,
    run.createdAt,
  );

  if (status === "completed") {
    await handleCompleted(
      runId,
      sessionId,
      run.userId,
      run.prompt,
      payload.threadId,
    );
  } else if (status === "failed") {
    const errorMessage = error ?? run.error ?? "Run failed";
    await handleFailed(
      runId,
      sessionId,
      run.userId,
      run.prompt,
      payload.threadId,
      errorMessage,
    );
  }

  return NextResponse.json({ success: true });
}
