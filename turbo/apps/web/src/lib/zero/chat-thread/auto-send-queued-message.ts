import { and, asc, desc, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { initServices } from "../../init-services";
import {
  GOAL_DONE_SENTINEL,
  buildWebAttachFilesPrompt,
  buildWebChatGoalPrompt,
  buildWebChatIncompleteContext,
  buildWebChatPrompt,
  type WebChatGoalContext,
  type WebChatIncompleteRound,
} from "../integration-prompt";
import { createZeroRun, fetchZeroAgentForRun } from "../zero-run-service";
import { getApiUrl, generateCallbackSecret } from "../../infra/callback";
import type { ChatCallbackPayload } from "../../infra/callback/callback-payloads";
import { publishUserSignal } from "../../infra/realtime/client";
import { logger } from "../../shared/logger";
import {
  getIncompleteRoundsSinceLastSuccess,
  getChatThreadIdForRun,
  getLatestSessionIdForThread,
  publishThreadListChanged,
} from "./chat-message-service";
import { resolveAttachFileUrls } from "./chat-thread-service";

const log = logger("auto-send-queued");

function containsGoalDoneSentinel(content: string | null): boolean {
  return content !== null && content.includes(GOAL_DONE_SENTINEL);
}

type QueuedUserMessage = {
  id: string;
  content: string | null;
  attachFiles: string[] | null;
  modelProviderId: string | null;
  modelProviderType: string | null;
  modelProviderCredentialScope: string | null;
  selectedModel: string | null;
  goalRemainingTurns: number | null;
  goalOriginMessageId: string | null;
};

async function nextQueuedUserMessage(
  threadId: string,
): Promise<QueuedUserMessage | null> {
  const [message] = await globalThis.services.db
    .select({
      id: chatMessages.id,
      content: chatMessages.content,
      attachFiles: chatMessages.attachFiles,
      modelProviderId: sql<null>`NULL`,
      modelProviderType: sql<null>`NULL`,
      modelProviderCredentialScope: sql<null>`NULL`,
      selectedModel: chatThreads.selectedModel,
      goalRemainingTurns: chatMessages.goalRemainingTurns,
      goalOriginMessageId: chatMessages.goalOriginMessageId,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatThreads.id, chatMessages.chatThreadId))
    .where(
      and(
        eq(chatMessages.chatThreadId, threadId),
        eq(chatMessages.role, "user"),
        isNull(chatMessages.archivedAt),
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

function buildAppendSystemPrompt(
  incompleteContext: string,
  goalContext: WebChatGoalContext | null,
): string {
  return [
    buildWebChatPrompt(),
    goalContext ? buildWebChatGoalPrompt(goalContext) : "",
    incompleteContext,
  ]
    .filter((part) => {
      return typeof part === "string" && part.length > 0;
    })
    .join("\n\n");
}

/**
 * Goal-mode continuation. Inspects the just-completed run to decide whether
 * to enqueue another turn against the same `/go` chain. The continuation
 * row is a verbatim copy of the triggering user row (same content body,
 * same attachments, same goal_origin_message_id) with the budget decremented;
 * inserting it with `run_id = NULL` lets the existing FIFO picker (above)
 * claim it on the next iteration.
 *
 * Stop conditions, in order:
 *   1. The callback's terminal status is not `completed` — any error/cancel
 *      ends the chain. No retry. The callback parameter is the source of
 *      truth: by the time this runs the run row may already have been
 *      updated, but the callback we're handling carries the authoritative
 *      terminal verdict for this delivery.
 *   2. The triggering message is not goal-driven (no goal_remaining_turns).
 *   3. A row with `interrupts_run_id = <runId>` exists — the user explicitly
 *      stopped the run.
 *   4. Any assistant message of the run contains `[GOAL_DONE]` — the agent
 *      voluntarily declared completion.
 *   5. `goal_remaining_turns <= 1` for the just-completed turn — budget spent.
 */
async function maybeInsertGoalContinuation(
  runId: string,
  terminalStatus: "completed" | "failed",
): Promise<void> {
  if (terminalStatus !== "completed") {
    return;
  }

  const [trigger] = await globalThis.services.db
    .select({
      threadId: chatMessages.chatThreadId,
      content: chatMessages.content,
      attachFiles: chatMessages.attachFiles,
      goalRemainingTurns: chatMessages.goalRemainingTurns,
      goalOriginMessageId: chatMessages.goalOriginMessageId,
    })
    .from(chatMessages)
    .where(and(eq(chatMessages.runId, runId), eq(chatMessages.role, "user")))
    .limit(1);

  if (!trigger) {
    return;
  }
  if (
    trigger.goalRemainingTurns === null ||
    trigger.goalOriginMessageId === null
  ) {
    return;
  }
  if (trigger.goalRemainingTurns <= 1) {
    return;
  }

  const [interrupt] = await globalThis.services.db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.interruptsRunId, runId))
    .limit(1);
  if (interrupt) {
    return;
  }

  // Sentinel scope: only the *last* assistant message of the run, matched in
  // application code (not SQL `LIKE`) so future tightening (e.g. last line
  // only, end-of-message anchor) lives in one place. Casual mentions of the
  // literal in earlier turns of the same run no longer false-positive.
  const [lastAssistant] = await globalThis.services.db
    .select({ content: chatMessages.content })
    .from(chatMessages)
    .where(
      and(
        eq(chatMessages.runId, runId),
        eq(chatMessages.role, "assistant"),
        isNotNull(chatMessages.content),
      ),
    )
    .orderBy(desc(chatMessages.sequenceNumber), desc(chatMessages.createdAt))
    .limit(1);
  if (lastAssistant && containsGoalDoneSentinel(lastAssistant.content)) {
    log.info("Goal chain stopped by sentinel", {
      runId,
      goalOriginMessageId: trigger.goalOriginMessageId,
    });
    return;
  }

  // Idempotency: `goalContinuationOfRunId` is unique-indexed. If this callback
  // fires twice for the same run (at-least-once delivery / retry), the second
  // insert hits the unique constraint and `onConflictDoNothing` makes it a
  // no-op — no duplicate continuation rows.
  await globalThis.services.db
    .insert(chatMessages)
    .values({
      chatThreadId: trigger.threadId,
      role: "user",
      content: trigger.content,
      runId: null,
      attachFiles: trigger.attachFiles,
      goalRemainingTurns: trigger.goalRemainingTurns - 1,
      goalOriginMessageId: trigger.goalOriginMessageId,
      goalContinuationOfRunId: runId,
    })
    .onConflictDoNothing({ target: chatMessages.goalContinuationOfRunId });
}

function groupIncompleteRoundsByRunId(
  rows: Awaited<ReturnType<typeof getIncompleteRoundsSinceLastSuccess>>,
): WebChatIncompleteRound[] {
  const byRunId = new Map<string, WebChatIncompleteRound>();
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
  return order.map((id) => {
    return byRunId.get(id)!;
  });
}

/**
 * After a chat run reaches a terminal state, claim the oldest unassociated user
 * message in the thread and dispatch it as the next run. The queued message row
 * itself is immutable; claiming appends a new user row that revokes the queued
 * row and carries the new run_id.
 */
export async function autoSendQueuedMessageOnRunComplete(input: {
  runId: string;
  agentId: string;
  apiStartTime: number;
  terminalStatus: "completed" | "failed";
}): Promise<void> {
  initServices();
  const { runId, agentId, apiStartTime, terminalStatus } = input;

  const chatThread = await getChatThreadIdForRun(runId);
  if (!chatThread) {
    return;
  }
  const { chatThreadId: threadId, userId } = chatThread;

  // If the just-completed run was driven by a `/go` and the chain is still
  // alive (run succeeded, no interrupt, no sentinel, budget remaining),
  // enqueue the next continuation row before consulting the FIFO picker.
  // The continuation is a fresh queued user message and will be picked up
  // immediately after — same code path as a real user-typed message.
  await maybeInsertGoalContinuation(runId, terminalStatus);

  const queuedMessage = await nextQueuedUserMessage(threadId);
  if (!queuedMessage) {
    return;
  }

  const [sessionId, incompleteRows] = await Promise.all([
    getLatestSessionIdForThread(threadId),
    getIncompleteRoundsSinceLastSuccess(threadId),
  ]);
  const incompleteContext = buildWebChatIncompleteContext(
    groupIncompleteRoundsByRunId(incompleteRows),
  );

  const agent = await fetchZeroAgentForRun(agentId);
  if (!agent) {
    log.warn("Auto-send aborted: agent not found", { threadId, agentId });
    return;
  }

  const resolvedAttachFiles =
    queuedMessage.attachFiles && queuedMessage.attachFiles.length > 0
      ? await resolveAttachFileUrls(userId, queuedMessage.attachFiles)
      : [];
  const attachFiles =
    resolvedAttachFiles.length > 0
      ? resolvedAttachFiles
      : (queuedMessage.attachFiles ?? []).map((id) => {
          return {
            id,
            filename: id,
            contentType: "application/octet-stream",
            size: 0,
            url: "",
          };
        });
  const content = queuedMessage.content ?? "";
  const fullPrompt =
    attachFiles.length === 0
      ? content
      : `${content}\n\n${buildWebAttachFilesPrompt(attachFiles)}`;

  const chatCallback: {
    url: string;
    secret: string;
    payload: ChatCallbackPayload;
  } = {
    url: getApiUrl() + "/api/internal/callbacks/chat",
    secret: generateCallbackSecret(),
    payload: { threadId, agentId },
  };

  const goalContext: WebChatGoalContext | null =
    queuedMessage.goalRemainingTurns !== null
      ? { remainingTurns: queuedMessage.goalRemainingTurns }
      : null;

  const run = await createZeroRun({
    userId,
    prompt: fullPrompt,
    agentId,
    sessionId,
    triggerSource: "web",
    apiStartTime,
    appendSystemPrompt: buildAppendSystemPrompt(incompleteContext, goalContext),
    callbacks: [chatCallback],
    chatThreadId: threadId,
    modelProvider: queuedMessage.modelProviderType ?? undefined,
    modelProviderId: queuedMessage.modelProviderId ?? undefined,
    modelProviderCredentialScope:
      queuedMessage.modelProviderCredentialScope ?? undefined,
    selectedModelOverride: queuedMessage.selectedModel ?? undefined,
    explicitModelFirstModelSelection: queuedMessage.selectedModel !== null,
    preloadedAgent: agent,
  });

  const claimed = await globalThis.services.db
    .insert(chatMessages)
    .values({
      chatThreadId: threadId,
      role: "user",
      content: queuedMessage.content,
      runId: run.runId,
      attachFiles: queuedMessage.attachFiles,
      revokesMessageId: queuedMessage.id,
      // Carry the goal columns onto the claim row so the next run-completion
      // callback can detect the chain via this row (since the claim row is
      // the one whose `runId` matches the just-completed run).
      goalRemainingTurns: queuedMessage.goalRemainingTurns,
      goalOriginMessageId: queuedMessage.goalOriginMessageId,
    })
    .onConflictDoNothing({ target: chatMessages.revokesMessageId })
    .returning({ id: chatMessages.id });

  if (claimed.length === 0) {
    await globalThis.services.db
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

  await publishUserSignal([userId], `chatThreadMessageCreated:${threadId}`);
  await publishUserSignal([userId], `chatThreadRunCreated:${threadId}`);
  await publishThreadListChanged(userId);
}
