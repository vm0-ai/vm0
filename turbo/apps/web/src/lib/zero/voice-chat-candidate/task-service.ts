import { and, desc, eq, inArray, sql } from "drizzle-orm";
import type { VoiceChatTaskResultEntry } from "@vm0/core/contracts/zero-voice-chat";
import {
  voiceChatItems,
  voiceChatSessions,
  voiceChatTasks,
} from "../../../db/schema/voice-chat";
import { type CreateZeroRunResult } from "../zero-run-service";
import { cancelRun, type CancelRunResult } from "../zero-run-cancel";
import { isRunNotCancellable, notFound } from "../../shared/errors";
import { logger } from "../../shared/logger";

const log = logger("zero:voice-chat-candidate:task");

type SpawnRun = (taskId: string) => Promise<CreateZeroRunResult>;

type TaskRow = typeof voiceChatTasks.$inferSelect;
type ItemRow = typeof voiceChatItems.$inferSelect;

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
    .insert(voiceChatTasks)
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
    .update(voiceChatTasks)
    .set({ runId: result.runId, status: nextStatus })
    .where(eq(voiceChatTasks.id, inserted.id))
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
  cancelledRuns: CancelRunResult[];
}> {
  const db = globalThis.services.db;

  const outcome = await db.transaction(async (tx) => {
    const [taskRow] = await tx
      .select()
      .from(voiceChatTasks)
      .where(eq(voiceChatTasks.id, params.taskId))
      .for("update")
      .limit(1);

    if (!taskRow) {
      throw notFound(`Voice-chat-candidate task not found: ${params.taskId}`);
    }

    const [sessionRow] = await tx
      .select()
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, taskRow.sessionId))
      .limit(1);

    if (!sessionRow) {
      throw notFound(
        `Voice-chat-candidate session not found: ${taskRow.sessionId}`,
      );
    }

    const now = new Date();

    if (sessionRow.agentId !== params.agentId) {
      // Defensive: task run callback arrived with the wrong agentId. Fail
      // the task and emit a system note; the session itself stays put —
      // sessions are stateless containers in the candidate model.
      const [failedTask] = await tx
        .update(voiceChatTasks)
        .set({
          status: "failed",
          error: "agent mismatch",
          finishedAt: now,
        })
        .where(eq(voiceChatTasks.id, taskRow.id))
        .returning();

      const [noteItem] = await tx
        .insert(voiceChatItems)
        .values({
          sessionId: taskRow.sessionId,
          role: "system_note",
          content: "agent mismatch — task failed",
          taskId: taskRow.id,
          realtimeItemId: null,
        })
        .returning();

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
    const finalEntries: VoiceChatTaskResultEntry[] = params.result
      ? [
          {
            type: "assistant",
            content: params.result,
            at: now.toISOString(),
          },
        ]
      : [];
    // Build the consolidated `result` column from the full assistant-message
    // stream (prior appended entries plus this final one). The Reasoner tick
    // later compacts this column in place.
    const priorContent = taskRow.assistantMessages
      .map((e) => {
        return e.content;
      })
      .join("\n");
    const finalContent = params.result ?? "";
    const consolidatedResult = [priorContent, finalContent]
      .filter((s) => {
        return s.length > 0;
      })
      .join("\n");
    const [completedTask] = await tx
      .update(voiceChatTasks)
      .set({
        status: finalStatus,
        assistantMessages: sql`${voiceChatTasks.assistantMessages} || ${JSON.stringify(finalEntries)}::jsonb`,
        result: consolidatedResult.length > 0 ? consolidatedResult : null,
        resultUpdatedAt: consolidatedResult.length > 0 ? now : null,
        error: params.error,
        finishedAt: now,
      })
      .where(eq(voiceChatTasks.id, taskRow.id))
      .returning();

    const [resultItem] = await tx
      .insert(voiceChatItems)
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

  const cancelledRuns = outcome.mismatch
    ? await cancelSessionPendingRuns(outcome.session)
    : [];

  return {
    task: outcome.task,
    item: outcome.item,
    session: { id: outcome.session.id, userId: outcome.session.userId },
    cancelledRuns,
  };
}

async function listPendingVoiceChatCandidateTasks(
  sessionId: string,
): Promise<TaskRow[]> {
  const db = globalThis.services.db;
  return db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, ["pending", "queued"]),
      ),
    );
}

export async function listSessionTasks(sessionId: string): Promise<TaskRow[]> {
  const db = globalThis.services.db;
  return db
    .select()
    .from(voiceChatTasks)
    .where(eq(voiceChatTasks.sessionId, sessionId))
    .orderBy(desc(voiceChatTasks.createdAt));
}

/**
 * Trinity task-card feed: every still-running task in createdAt ASC order,
 * followed by up to the 3 most-recently-finished tasks in finishedAt DESC
 * order. The combined list is full-replaced by the client on every Ably
 * tick — there is no cursor.
 */
export async function listSessionTasksForCard(
  sessionId: string,
  recentFinishedLimit = 3,
): Promise<TaskRow[]> {
  const db = globalThis.services.db;
  const active = await db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, ["pending", "queued", "running"]),
      ),
    )
    .orderBy(voiceChatTasks.createdAt);

  if (recentFinishedLimit <= 0) {
    return active;
  }

  const finished = await db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(voiceChatTasks.finishedAt))
    .limit(recentFinishedLimit);

  return [...active, ...finished];
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
    .update(voiceChatTasks)
    .set({ status: "running", startedAt: new Date() })
    .where(
      and(
        eq(voiceChatTasks.runId, runId),
        inArray(voiceChatTasks.status, ["pending", "queued"]),
      ),
    )
    .returning({ sessionId: voiceChatTasks.sessionId });

  if (!row) return null;

  const [session] = await db
    .select({ userId: voiceChatSessions.userId })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, row.sessionId))
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
  entries: VoiceChatTaskResultEntry[];
}): Promise<{ sessionId: string; userId: string } | null> {
  if (params.entries.length === 0) return null;
  const db = globalThis.services.db;
  const [row] = await db
    .update(voiceChatTasks)
    .set({
      assistantMessages: sql`${voiceChatTasks.assistantMessages} || ${JSON.stringify(params.entries)}::jsonb`,
    })
    .where(
      and(
        eq(voiceChatTasks.runId, params.runId),
        inArray(voiceChatTasks.status, ["pending", "queued", "running"]),
      ),
    )
    .returning({ sessionId: voiceChatTasks.sessionId });

  if (!row) return null;

  const [session] = await db
    .select({ userId: voiceChatSessions.userId })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, row.sessionId))
    .limit(1);

  if (!session) return null;
  return { sessionId: row.sessionId, userId: session.userId };
}

// Returns the `CancelRunResult` for each run this call actually transitioned
// to `cancelled`. `alreadyCancelled` replays are filtered out — the original
// caller owned their side effects. The caller is responsible for invoking
// `dispatchCancelSideEffects` / `processOrgCredits`; this module stays free of
// Next.js request-context coupling so non-HTTP callers remain safe.
async function cancelSessionPendingRuns(session: {
  id: string;
  orgId: string;
  userId: string;
}): Promise<CancelRunResult[]> {
  const pending = await listPendingVoiceChatCandidateTasks(session.id);
  const cancelled: CancelRunResult[] = [];
  for (const task of pending) {
    if (!task.runId) continue;
    try {
      const result = await cancelRun(task.runId, session.userId, session.orgId);
      if (!result.alreadyCancelled) cancelled.push(result);
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
  return cancelled;
}

function formatTaskResult(params: {
  result: string | null;
  error: string | null;
}): string {
  if (params.error) return `[task failed] ${params.error}`;
  return params.result ?? "[task returned empty result]";
}
