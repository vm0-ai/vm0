import { eq } from "drizzle-orm";
import { chatMessages } from "@vm0/db/schema/chat-message";
import { chatThreads } from "@vm0/db/schema/chat-thread";
import { zeroRuns } from "@vm0/db/schema/zero-run";

import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";

/**
 * Fire the user-level "artifact catalog changed" signal. The artifacts page
 * subscribes to it and re-reads only its first page, because new artifacts
 * always sort to the head.
 */
export async function publishArtifactCatalogChanged(
  authorUserIds: readonly string[],
): Promise<void> {
  await publishUserSignal(
    [...new Set(authorUserIds)],
    "artifactCatalogChanged",
  );
}

export async function publishArtifactsChangedForRun(
  writeDb: Db,
  runId: string,
  signal: AbortSignal,
): Promise<void> {
  const [zeroRunThread] = await writeDb
    .select({
      chatThreadId: zeroRuns.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(zeroRuns)
    .innerJoin(chatThreads, eq(zeroRuns.chatThreadId, chatThreads.id))
    .where(eq(zeroRuns.id, runId))
    .limit(1);
  signal.throwIfAborted();

  if (zeroRunThread?.chatThreadId) {
    await publishUserSignal(
      [zeroRunThread.userId],
      `chatThreadArtifactsChanged:${zeroRunThread.chatThreadId}`,
    );
    signal.throwIfAborted();
    return;
  }

  const [messageThread] = await writeDb
    .select({
      chatThreadId: chatMessages.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(chatMessages)
    .innerJoin(chatThreads, eq(chatMessages.chatThreadId, chatThreads.id))
    .where(eq(chatMessages.runId, runId))
    .limit(1);
  signal.throwIfAborted();

  if (messageThread) {
    await publishUserSignal(
      [messageThread.userId],
      `chatThreadArtifactsChanged:${messageThread.chatThreadId}`,
    );
    signal.throwIfAborted();
  }
}
