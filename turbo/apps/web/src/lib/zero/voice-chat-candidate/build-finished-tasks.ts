import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { featureCandidateVoiceChatTasks } from "../../../db/schema/voice-chat-candidate";

type TaskRow = typeof featureCandidateVoiceChatTasks.$inferSelect;

async function loadFinishedTaskRows(sessionId: string): Promise<TaskRow[]> {
  const db = globalThis.services.db;
  return db
    .select()
    .from(featureCandidateVoiceChatTasks)
    .where(
      and(
        eq(featureCandidateVoiceChatTasks.sessionId, sessionId),
        inArray(featureCandidateVoiceChatTasks.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(featureCandidateVoiceChatTasks.finishedAt));
}

function flattenAssistantEntries(row: TaskRow): string {
  return row.assistantMessages
    .map((e) => {
      return e.content;
    })
    .join("\n");
}

function renderRow(row: TaskRow, body: string): string {
  const header = `[Task ${row.id}] ${row.status}`;
  const parts = [header, `prompt: ${row.prompt}`];
  if (body) parts.push(`result:\n${body}`);
  if (row.error) parts.push(`error: ${row.error}`);
  return parts.join("\n");
}

/**
 * Raw, uncompacted finished-task log. The body comes straight from the
 * `assistantMessages` stream, so it reflects exactly what the Task Run
 * emitted — unaffected by the periodic compactor. Used by the UI reasoner
 * panel so developers always see the real result.
 */
export async function buildFinishedTasksFullText(
  sessionId: string,
): Promise<string> {
  const rows = await loadFinishedTaskRows(sessionId);
  if (rows.length === 0) return "";
  return rows
    .map((row) => {
      return renderRow(row, flattenAssistantEntries(row));
    })
    .join("\n\n");
}

/**
 * Compaction-aware finished-task log. Prefers the `result` column (which is
 * maintained by the compactor tick), falling back to the raw
 * `assistantMessages` stream when `result` hasn't been written yet. Used
 * when assembling the Talker instruction so long-lived sessions don't bloat
 * the Realtime prompt.
 */
export async function buildFinishedTasksCompactedText(
  sessionId: string,
): Promise<string> {
  const rows = await loadFinishedTaskRows(sessionId);
  if (rows.length === 0) return "";
  return rows
    .map((row) => {
      const body = row.result ?? flattenAssistantEntries(row);
      return renderRow(row, body);
    })
    .join("\n\n");
}
