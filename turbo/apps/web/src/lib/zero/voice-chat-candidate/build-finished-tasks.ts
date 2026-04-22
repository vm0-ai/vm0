import "server-only";
import { and, desc, eq, inArray } from "drizzle-orm";
import { featureCandidateVoiceChatTasks } from "../../../db/schema/voice-chat-candidate";

export async function buildFinishedTasksFullText(
  sessionId: string,
): Promise<string> {
  const db = globalThis.services.db;
  const rows = await db
    .select()
    .from(featureCandidateVoiceChatTasks)
    .where(
      and(
        eq(featureCandidateVoiceChatTasks.sessionId, sessionId),
        inArray(featureCandidateVoiceChatTasks.status, ["done", "failed"]),
      ),
    )
    .orderBy(desc(featureCandidateVoiceChatTasks.finishedAt));

  if (rows.length === 0) return "";

  return rows
    .map((row) => {
      const header = `[Task ${row.id}] ${row.status}`;
      const parts = [header, `prompt: ${row.prompt}`];
      const body = row.assistantMessages
        .map((e) => {
          return e.content;
        })
        .join("\n");
      if (body) parts.push(`result:\n${body}`);
      if (row.error) parts.push(`error: ${row.error}`);
      return parts.join("\n");
    })
    .join("\n\n");
}
