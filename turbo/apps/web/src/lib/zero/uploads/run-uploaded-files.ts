import { eq, sql } from "drizzle-orm";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import {
  runUploadedFiles,
  type RunUploadedFileSource,
} from "@vm0/db/schema/run-uploaded-file";
import { zeroRuns } from "@vm0/db/schema/zero-run";
import { publishUserSignal } from "../../infra/realtime/client";

type RecordRunUploadedFileParams = {
  runId: string | undefined;
  source: RunUploadedFileSource;
  externalId: string;
  userId: string;
  orgId?: string | null;
  filename?: string | null;
  contentType?: string | null;
  sizeBytes?: number | null;
  url?: string | null;
  metadata?: Record<string, unknown>;
};

export async function recordRunUploadedFile({
  runId,
  source,
  externalId,
  userId,
  orgId,
  filename,
  contentType,
  sizeBytes,
  url,
  metadata,
}: RecordRunUploadedFileParams): Promise<void> {
  if (!runId) return;

  await globalThis.services.db
    .insert(runUploadedFiles)
    .values({
      runId,
      source,
      externalId,
      userId,
      orgId: orgId ?? null,
      filename: filename ?? null,
      contentType: contentType ?? null,
      sizeBytes: sizeBytes ?? null,
      url: url ?? null,
      metadata: metadata ?? {},
    })
    .onConflictDoUpdate({
      target: [
        runUploadedFiles.runId,
        runUploadedFiles.source,
        runUploadedFiles.externalId,
      ],
      set: {
        userId,
        orgId: orgId ?? null,
        filename: filename ?? null,
        contentType: contentType ?? null,
        sizeBytes: sizeBytes ?? null,
        url: url ?? null,
        metadata: metadata ?? {},
        updatedAt: sql`now()`,
      },
    });

  await publishChatThreadArtifactsChanged(runId);
}

async function getChatThreadForRun(
  runId: string,
): Promise<{ chatThreadId: string; userId: string } | null> {
  const [zeroRunThread] = await globalThis.services.db
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(zeroRuns)
    .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);

  if (zeroRunThread?.chatThreadId) {
    return {
      chatThreadId: zeroRunThread.chatThreadId,
      userId: zeroRunThread.userId,
    };
  }

  const [messageThread] = await globalThis.services.db
    .select({
      chatThreadId: chatMessages.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatMessages.chatThreadId, chatThreads.id))
    .where(eq(chatMessages.runId, runId))
    .limit(1);

  return messageThread ?? null;
}

async function publishChatThreadArtifactsChanged(runId: string): Promise<void> {
  const chatThread = await getChatThreadForRun(runId);
  if (!chatThread) return;

  await publishUserSignal(
    [chatThread.userId],
    `chatThreadArtifactsChanged:${chatThread.chatThreadId}`,
  );
}
