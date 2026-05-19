import { desc, eq } from "drizzle-orm";
import { voiceChatTasks } from "@vm0/db/schema/voice-chat";
import { type CreateZeroRunResult } from "../zero-run-service";

type SpawnRun = (taskId: string) => Promise<CreateZeroRunResult>;

type TaskRow = typeof voiceChatTasks.$inferSelect;

export async function createVoiceChatTask(params: {
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
    throw new Error("Failed to insert voice-chat task");
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

export async function listSessionTasks(sessionId: string): Promise<TaskRow[]> {
  const db = globalThis.services.db;
  return db
    .select()
    .from(voiceChatTasks)
    .where(eq(voiceChatTasks.sessionId, sessionId))
    .orderBy(desc(voiceChatTasks.createdAt));
}
