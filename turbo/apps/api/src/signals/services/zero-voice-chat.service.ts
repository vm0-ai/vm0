import { computed, type Computed } from "ccstate";
import { voiceChatSessions, voiceChatTasks } from "@vm0/db/schema/voice-chat";
import { and, asc, desc, eq, inArray } from "drizzle-orm";

import { db$ } from "../external/db";

const ACTIVE_TASK_STATUSES = ["pending", "queued", "running"] as const;
const FINISHED_TASK_STATUSES = ["done", "failed"] as const;
const MAX_FINISHED_TASKS = 3;

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
