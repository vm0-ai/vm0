import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { VoiceChatCandidateTaskResultEntry } from "@vm0/core";
import {
  featureCandidateVoiceChatItems,
  featureCandidateVoiceChatSessions,
  featureCandidateVoiceChatTasks,
} from "../../../db/schema/voice-chat-candidate";
import { type CreateZeroRunResult } from "../zero-run-service";
import { cancelRun } from "../zero-run-cancel";
import { isRunNotCancellable, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat-candidate:task");

export type SpawnRun = (taskId: string) => Promise<CreateZeroRunResult>;

type TaskRow = typeof featureCandidateVoiceChatTasks.$inferSelect;
type ItemRow = typeof featureCandidateVoiceChatItems.$inferSelect;

export async function createVoiceChatCandidateTask(params: {
  sessionId: string;
  callId: string;
  prompt: string;
  spawnRun: SpawnRun;
}): Promise<TaskRow> {
  const db = globalThis.services.db;

  // Insert the task row BEFORE spawning the run so the callback path can
  // always locate a task by runId even if the callback beats the post-spawn
  // UPDATE.
  const [inserted] = await db
    .insert(featureCandidateVoiceChatTasks)
    .values({
      sessionId: params.sessionId,
      callId: params.callId,
      prompt: params.prompt,
      status: "pending",
    })
    .returning();

  if (!inserted) {
    throw new Error("Failed to insert voice-chat-candidate task");
  }

  const result = await params.spawnRun(inserted.id);

  const nextStatus = result.status === "queued" ? "queued" : "pending";
  const [updated] = await db
    .update(featureCandidateVoiceChatTasks)
    .set({ runId: result.runId, status: nextStatus })
    .where(eq(featureCandidateVoiceChatTasks.id, inserted.id))
    .returning();

  return updated ?? inserted;
}

export async function completeVoiceChatCandidateTask(params: {
  taskId: string;
  result: string | null;
  error: string | null;
  agentId: string;
}): Promise<{
  item: ItemRow;
  task: TaskRow;
  session: { id: string; userId: string };
}> {
  const db = globalThis.services.db;

  const outcome = await db.transaction(async (tx) => {
    const [taskRow] = await tx
      .select()
      .from(featureCandidateVoiceChatTasks)
      .where(eq(featureCandidateVoiceChatTasks.id, params.taskId))
      .for("update")
      .limit(1);

    if (!taskRow) {
      throw notFound(`Voice-chat-candidate task not found: ${params.taskId}`);
    }

    const [sessionRow] = await tx
      .select()
      .from(featureCandidateVoiceChatSessions)
      .where(eq(featureCandidateVoiceChatSessions.id, taskRow.sessionId))
      .limit(1);

    if (!sessionRow) {
      throw notFound(
        `Voice-chat-candidate session not found: ${taskRow.sessionId}`,
      );
    }

    const now = new Date();

    if (sessionRow.agentId !== params.agentId) {
      const [failedTask] = await tx
        .update(featureCandidateVoiceChatTasks)
        .set({
          status: "failed",
          error: "agent mismatch",
          finishedAt: now,
        })
        .where(eq(featureCandidateVoiceChatTasks.id, taskRow.id))
        .returning();

      const [noteItem] = await tx
        .insert(featureCandidateVoiceChatItems)
        .values({
          sessionId: taskRow.sessionId,
          role: "system_note",
          content: "agent mismatch — session ended",
          taskId: taskRow.id,
          realtimeItemId: null,
        })
        .returning();

      await tx
        .update(featureCandidateVoiceChatSessions)
        .set({ status: "ended", endedAt: now })
        .where(eq(featureCandidateVoiceChatSessions.id, taskRow.sessionId));

      return {
        task: failedTask ?? taskRow,
        item: noteItem!,
        mismatch: true,
        session: {
          id: sessionRow.id,
          orgId: sessionRow.orgId,
          userId: sessionRow.userId,
        },
      };
    }

    const finalStatus = params.error ? "failed" : "done";
    const finalEntries: VoiceChatCandidateTaskResultEntry[] = params.result
      ? [
          {
            type: "assistant",
            content: params.result,
            at: now.toISOString(),
          },
        ]
      : [];
    const [completedTask] = await tx
      .update(featureCandidateVoiceChatTasks)
      .set({
        status: finalStatus,
        assistantMessages: sql`${featureCandidateVoiceChatTasks.assistantMessages} || ${JSON.stringify(finalEntries)}::jsonb`,
        error: params.error,
        finishedAt: now,
      })
      .where(eq(featureCandidateVoiceChatTasks.id, taskRow.id))
      .returning();

    const [resultItem] = await tx
      .insert(featureCandidateVoiceChatItems)
      .values({
        sessionId: taskRow.sessionId,
        role: "task_result",
        content: formatTaskResult({
          result: params.result,
          error: params.error,
        }),
        taskId: taskRow.id,
        realtimeItemId: null,
      })
      .returning();

    return {
      task: completedTask ?? taskRow,
      item: resultItem!,
      mismatch: false,
      session: {
        id: sessionRow.id,
        orgId: sessionRow.orgId,
        userId: sessionRow.userId,
      },
    };
  });

  if (outcome.mismatch) {
    await cancelSessionPendingRuns(outcome.session);
  }

  return {
    task: outcome.task,
    item: outcome.item,
    session: { id: outcome.session.id, userId: outcome.session.userId },
  };
}

export async function listPendingVoiceChatCandidateTasks(
  sessionId: string,
): Promise<TaskRow[]> {
  const db = globalThis.services.db;
  return db
    .select()
    .from(featureCandidateVoiceChatTasks)
    .where(
      and(
        eq(featureCandidateVoiceChatTasks.sessionId, sessionId),
        inArray(featureCandidateVoiceChatTasks.status, ["pending", "queued"]),
      ),
    );
}

export async function listSessionTasks(sessionId: string): Promise<TaskRow[]> {
  const db = globalThis.services.db;
  return db
    .select()
    .from(featureCandidateVoiceChatTasks)
    .where(eq(featureCandidateVoiceChatTasks.sessionId, sessionId))
    .orderBy(desc(featureCandidateVoiceChatTasks.createdAt));
}

/**
 * Flip a task from pending/queued to running on the first event seen. No-op
 * when the task row is absent (not a voice-chat run) or already past the
 * running transition. Returns the session + user for Ably fan-out when a row
 * was updated.
 */
export async function markTaskRunningIfQueued(
  runId: string,
): Promise<{ sessionId: string; userId: string } | null> {
  const db = globalThis.services.db;
  const [row] = await db
    .update(featureCandidateVoiceChatTasks)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(featureCandidateVoiceChatTasks.runId, runId),
        inArray(featureCandidateVoiceChatTasks.status, ["pending", "queued"]),
      ),
    )
    .returning({ sessionId: featureCandidateVoiceChatTasks.sessionId });

  if (!row) return null;

  const [session] = await db
    .select({ userId: featureCandidateVoiceChatSessions.userId })
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, row.sessionId))
    .limit(1);

  if (!session) return null;
  return { sessionId: row.sessionId, userId: session.userId };
}

/**
 * Append assistant-message entries to `tasks.assistant_messages`. Silent no-op when
 * the task is unknown (not a voice-chat run) or terminal. Returns session+user
 * on success.
 */
export async function appendTaskAssistantResult(params: {
  runId: string;
  entries: VoiceChatCandidateTaskResultEntry[];
}): Promise<{ sessionId: string; userId: string } | null> {
  if (params.entries.length === 0) return null;
  const db = globalThis.services.db;
  const [row] = await db
    .update(featureCandidateVoiceChatTasks)
    .set({
      assistantMessages: sql`${featureCandidateVoiceChatTasks.assistantMessages} || ${JSON.stringify(params.entries)}::jsonb`,
    })
    .where(
      and(
        eq(featureCandidateVoiceChatTasks.runId, params.runId),
        inArray(featureCandidateVoiceChatTasks.status, [
          "pending",
          "queued",
          "running",
        ]),
      ),
    )
    .returning({ sessionId: featureCandidateVoiceChatTasks.sessionId });

  if (!row) return null;

  const [session] = await db
    .select({ userId: featureCandidateVoiceChatSessions.userId })
    .from(featureCandidateVoiceChatSessions)
    .where(eq(featureCandidateVoiceChatSessions.id, row.sessionId))
    .limit(1);

  if (!session) return null;
  return { sessionId: row.sessionId, userId: session.userId };
}

export async function cancelSessionPendingRuns(session: {
  id: string;
  orgId: string;
  userId: string;
}): Promise<void> {
  const pending = await listPendingVoiceChatCandidateTasks(session.id);
  for (const task of pending) {
    if (!task.runId) continue;
    try {
      await cancelRun(task.runId, session.userId, session.orgId);
    } catch (err) {
      // Only swallow the expected "already terminal" signal from the run
      // state machine. Any other error (DB failure, permission mismatch,
      // network, etc.) must propagate so the caller can react.
      if (!isRunNotCancellable(err)) throw err;
      log.warn(
        `cancelRun for task ${task.id} (runId=${task.runId}) skipped — run is no longer cancellable: ${String(
          err,
        )}`,
      );
    }
  }
}

function formatTaskResult(params: {
  result: string | null;
  error: string | null;
}): string {
  if (params.error) return `[task failed] ${params.error}`;
  return params.result ?? "[task returned empty result]";
}
