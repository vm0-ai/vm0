import { command, computed, type Computed } from "ccstate";
import type {
  VoiceChatSession,
  VoiceChatTask,
  VoiceChatTaskResultEntry,
} from "@vm0/api-contracts/contracts/zero-voice-chat";
import { voiceChatSessions, voiceChatTasks } from "@vm0/db/schema/voice-chat";
import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { db$, writeDb$ } from "../external/db";

const ACTIVE_TASK_STATUSES = ["pending", "queued", "running"] as const;
const FINISHED_TASK_STATUSES = ["done", "failed"] as const;
const MAX_FINISHED_TASKS = 3;

/**
 * Map a `voice_chat_sessions` row to the contract-shaped `VoiceChatSession`
 * DTO. Mirrors web's `serializeVoiceChatSession` in
 * `apps/web/app/api/zero/voice-chat/_support.ts` so the contract -> row
 * mapping has a single source of truth across the api migration. Sibling
 * routes (`getSession`, `listTasks`) reuse this when they migrate.
 */
export function serializeVoiceChatSession(
  session: typeof voiceChatSessions.$inferSelect,
): VoiceChatSession {
  return {
    id: session.id,
    orgId: session.orgId,
    userId: session.userId,
    agentId: session.agentId,
    mode: "chat",
    conversationSummary: session.conversationSummary,
    workingTasksSummary: session.workingTasksSummary,
    finishedTasksSummary: session.finishedTasksSummary,
    summarySeq: session.summarySeq,
    summaryVersion: session.summaryVersion,
    lastSummaryAt: session.lastSummaryAt?.toISOString() ?? null,
    createdAt: session.createdAt.toISOString(),
  };
}

export function voiceChatSessionList(
  orgId: string,
  userId: string,
): Computed<Promise<(typeof voiceChatSessions.$inferSelect)[]>> {
  return computed((get) => {
    const db = get(db$);
    return db
      .select()
      .from(voiceChatSessions)
      .where(
        and(
          eq(voiceChatSessions.orgId, orgId),
          eq(voiceChatSessions.userId, userId),
        ),
      )
      .orderBy(desc(voiceChatSessions.createdAt));
  });
}

export function voiceChatSessionDetail(
  orgId: string,
  userId: string,
  sessionId: string,
): Computed<Promise<typeof voiceChatSessions.$inferSelect | null>> {
  return computed(async (get) => {
    const db = get(db$);
    const [session] = await db
      .select()
      .from(voiceChatSessions)
      .where(
        and(
          eq(voiceChatSessions.id, sessionId),
          eq(voiceChatSessions.orgId, orgId),
          eq(voiceChatSessions.userId, userId),
        ),
      )
      .limit(1);
    return session ?? null;
  });
}

/**
 * Map a `voice_chat_tasks` row to the contract-shaped `VoiceChatTask` DTO.
 * Mirrors web's `serializeVoiceChatTask` in
 * `apps/web/app/api/zero/voice-chat/_support.ts` so the contract -> row
 * mapping has a single source of truth across the api migration.
 */
export function serializeVoiceChatTask(
  task: typeof voiceChatTasks.$inferSelect,
): VoiceChatTask {
  return {
    id: task.id,
    sessionId: task.sessionId,
    runId: task.runId,
    callId: task.callId,
    prompt: task.prompt,
    status: task.status as VoiceChatTask["status"],
    result: task.result,
    resultUpdatedAt: task.resultUpdatedAt?.toISOString() ?? null,
    assistantMessages: task.assistantMessages,
    error: task.error,
    createdAt: task.createdAt.toISOString(),
    startedAt: task.startedAt?.toISOString() ?? null,
    finishedAt: task.finishedAt?.toISOString() ?? null,
  };
}

export function voiceChatTaskList(
  sessionId: string,
): Computed<Promise<(typeof voiceChatTasks.$inferSelect)[]>> {
  return computed(async (get) => {
    const db = get(db$);

    const active = await db
      .select()
      .from(voiceChatTasks)
      .where(
        and(
          eq(voiceChatTasks.sessionId, sessionId),
          inArray(voiceChatTasks.status, ACTIVE_TASK_STATUSES),
        ),
      )
      .orderBy(asc(voiceChatTasks.createdAt));

    const finished = await db
      .select()
      .from(voiceChatTasks)
      .where(
        and(
          eq(voiceChatTasks.sessionId, sessionId),
          inArray(voiceChatTasks.status, FINISHED_TASK_STATUSES),
        ),
      )
      .orderBy(desc(voiceChatTasks.finishedAt))
      .limit(MAX_FINISHED_TASKS);

    return [...active, ...finished];
  });
}

export const markVoiceChatTaskRunningIfQueued$ = command(
  async (
    { set },
    runId: string,
    signal: AbortSignal,
  ): Promise<{
    readonly sessionId: string;
    readonly userId: string;
  } | null> => {
    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .update(voiceChatTasks)
      .set({ status: "running", startedAt: nowDate() })
      .where(
        and(
          eq(voiceChatTasks.runId, runId),
          inArray(voiceChatTasks.status, ["pending", "queued"]),
        ),
      )
      .returning({ sessionId: voiceChatTasks.sessionId });
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    const [session] = await writeDb
      .select({ userId: voiceChatSessions.userId })
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, row.sessionId))
      .limit(1);
    signal.throwIfAborted();

    if (!session) {
      return null;
    }
    return { sessionId: row.sessionId, userId: session.userId };
  },
);

export const appendVoiceChatTaskAssistantResult$ = command(
  async (
    { set },
    args: {
      readonly runId: string;
      readonly entries: readonly VoiceChatTaskResultEntry[];
    },
    signal: AbortSignal,
  ): Promise<{
    readonly sessionId: string;
    readonly userId: string;
  } | null> => {
    if (args.entries.length === 0) {
      return null;
    }

    const writeDb = set(writeDb$);
    const [row] = await writeDb
      .update(voiceChatTasks)
      .set({
        assistantMessages: sql`${voiceChatTasks.assistantMessages} || ${JSON.stringify([...args.entries])}::jsonb`,
      })
      .where(
        and(
          eq(voiceChatTasks.runId, args.runId),
          inArray(voiceChatTasks.status, ["pending", "queued", "running"]),
        ),
      )
      .returning({ sessionId: voiceChatTasks.sessionId });
    signal.throwIfAborted();

    if (!row) {
      return null;
    }

    const [session] = await writeDb
      .select({ userId: voiceChatSessions.userId })
      .from(voiceChatSessions)
      .where(eq(voiceChatSessions.id, row.sessionId))
      .limit(1);
    signal.throwIfAborted();

    if (!session) {
      return null;
    }
    return { sessionId: row.sessionId, userId: session.userId };
  },
);
