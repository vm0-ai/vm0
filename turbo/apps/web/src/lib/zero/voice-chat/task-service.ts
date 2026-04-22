import { and, asc, eq, inArray, type InferSelectModel } from "drizzle-orm";
import {
  voiceChatEvents,
  voiceChatSessions,
  voiceChatTasks,
} from "../../../db/schema/voice-chat";
import { cancelRun } from "../zero-run-cancel";
import { isRunNotCancellable } from "../../shared/errors";
import { logger } from "../../shared/logger";

const log = logger("voice-chat:task-service");

export type VoiceChatTask = InferSelectModel<typeof voiceChatTasks>;

export type VoiceChatTaskTerminalStatus = "done" | "failed";

const IN_FLIGHT_STATUSES = ["pending", "queued", "running"] as const;

export async function createVoiceChatTask(params: {
  sessionId: string;
  prompt: string;
}): Promise<VoiceChatTask> {
  const [row] = await globalThis.services.db
    .insert(voiceChatTasks)
    .values({
      sessionId: params.sessionId,
      prompt: params.prompt,
      status: "pending",
    })
    .returning();
  return row!;
}

export async function attachTaskRun(params: {
  taskId: string;
  runId: string;
}): Promise<VoiceChatTask | null> {
  const [row] = await globalThis.services.db
    .update(voiceChatTasks)
    .set({ runId: params.runId, status: "queued" })
    .where(eq(voiceChatTasks.id, params.taskId))
    .returning();
  return row ?? null;
}

export async function completeVoiceChatTask(params: {
  taskId: string;
  status: VoiceChatTaskTerminalStatus;
  result: string | null;
  error: string | null;
}): Promise<VoiceChatTask | null> {
  const [row] = await globalThis.services.db
    .update(voiceChatTasks)
    .set({
      status: params.status,
      result: params.result,
      error: params.error,
      finishedAt: new Date(),
    })
    .where(eq(voiceChatTasks.id, params.taskId))
    .returning();
  return row ?? null;
}

export async function getVoiceChatTask(
  taskId: string,
): Promise<VoiceChatTask | null> {
  const [row] = await globalThis.services.db
    .select()
    .from(voiceChatTasks)
    .where(eq(voiceChatTasks.id, taskId))
    .limit(1);
  return row ?? null;
}

export async function listVoiceChatTasks(
  sessionId: string,
): Promise<VoiceChatTask[]> {
  return globalThis.services.db
    .select()
    .from(voiceChatTasks)
    .where(eq(voiceChatTasks.sessionId, sessionId))
    .orderBy(asc(voiceChatTasks.createdAt));
}

const TASK_EVENT_CONTENT_MAX = 2000;

function truncateTaskEventField(s: string | null | undefined): string | null {
  if (s == null) return null;
  return s.length > TASK_EVENT_CONTENT_MAX
    ? `${s.slice(0, TASK_EVENT_CONTENT_MAX)}…`
    : s;
}

type TaskEventInput =
  | {
      type: "task-dispatched";
      taskId: string;
      prompt: string;
    }
  | {
      type: "task-completed";
      taskId: string;
      status: VoiceChatTaskTerminalStatus;
      result: string | null;
      error: string | null;
    };

/**
 * Append a system-source task lifecycle event directly into the blackboard.
 *
 * Why: `appendEvent()` in context-service rejects writes when the session is
 * not active/preparing. Task callbacks can legitimately arrive after
 * `endSession` has flipped the session to "ended" (the cancel step races with
 * runs that are already terminating), so system writes bypass that gate the
 * same way `endSession` itself does when emitting `session-end`.
 *
 * Content is JSON with the task subject (prompt on dispatch, status/result/error
 * on completion) so fast-brain and the tasks-panel UI can render human-readable
 * context without a secondary fetch. Fields are truncated at 2000 chars.
 */
export async function appendTaskEvent(
  sessionId: string,
  input: TaskEventInput,
): Promise<void> {
  const content =
    input.type === "task-dispatched"
      ? JSON.stringify({
          taskId: input.taskId,
          prompt: truncateTaskEventField(input.prompt),
        })
      : JSON.stringify({
          taskId: input.taskId,
          status: input.status,
          result: truncateTaskEventField(input.result),
          error: truncateTaskEventField(input.error),
        });

  await globalThis.services.db.insert(voiceChatEvents).values({
    sessionId,
    source: "system",
    type: input.type,
    content,
  });
}

/**
 * Cancel every in-flight task for a session (pending, queued, running),
 * best-effort cancelling their backing Zero runs and marking the task rows
 * failed with `error="session ended"`.
 */
export async function cancelSessionPendingRuns(
  sessionId: string,
): Promise<void> {
  const [session] = await globalThis.services.db
    .select({
      userId: voiceChatSessions.userId,
      orgId: voiceChatSessions.orgId,
    })
    .from(voiceChatSessions)
    .where(eq(voiceChatSessions.id, sessionId))
    .limit(1);
  if (!session) return;

  const inFlight = await globalThis.services.db
    .select({ id: voiceChatTasks.id, runId: voiceChatTasks.runId })
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, [...IN_FLIGHT_STATUSES]),
      ),
    );

  for (const task of inFlight) {
    if (!task.runId) continue;
    try {
      await cancelRun(task.runId, session.userId, session.orgId);
    } catch (err) {
      if (!isRunNotCancellable(err)) throw err;
      log.warn(
        `cancelRun for task ${task.id} (runId=${task.runId}) skipped — run is no longer cancellable: ${String(
          err,
        )}`,
      );
    }
  }

  await globalThis.services.db
    .update(voiceChatTasks)
    .set({
      status: "failed",
      error: "session ended",
      finishedAt: new Date(),
    })
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, [...IN_FLIGHT_STATUSES]),
      ),
    );
}
