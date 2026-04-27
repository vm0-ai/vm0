import "server-only";
import { and, asc, eq, inArray } from "drizzle-orm";
import { voiceChatTasks } from "@vm0/db/schema/voice-chat";

const ACTIVE_STATUSES = ["pending", "queued", "running"] as const;

/**
 * DB-direct rendering of tasks currently in-flight for a session. Used as the
 * `### In flight` slot of the Talker's Task board. The reasoner no longer
 * narrates task state — this query is the source of truth for "what is
 * running right now", and it updates the instant a task row changes.
 */
export async function buildInFlightTasksText(
  sessionId: string,
): Promise<string> {
  const db = globalThis.services.db;
  const rows = await db
    .select()
    .from(voiceChatTasks)
    .where(
      and(
        eq(voiceChatTasks.sessionId, sessionId),
        inArray(voiceChatTasks.status, [...ACTIVE_STATUSES]),
      ),
    )
    .orderBy(asc(voiceChatTasks.createdAt));

  if (rows.length === 0) return "";

  const now = Date.now();
  return rows
    .map((row) => {
      const elapsedSec = Math.round((now - row.createdAt.getTime()) / 1000);
      const header = `[Task ${row.id}] ${row.status} (elapsed ${String(elapsedSec)}s)`;
      return [header, `prompt: ${row.prompt}`].join("\n");
    })
    .join("\n\n");
}
