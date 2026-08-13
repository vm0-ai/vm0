import { eq } from "drizzle-orm";
import { chatEvents } from "@okouai/db/schema/chat-event";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { zeroRuns } from "@okouai/db/schema/zero-run";

import type { Db } from "../external/db";
import { publishUserSignal } from "../external/realtime";
import { runOwnedChatEventForRunCondition } from "./zero-chat-event-type.service";

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
      chatThreadId: chatEvents.chatThreadId,
      userId: chatThreads.userId,
    })
    .from(chatEvents)
    .innerJoin(chatThreads, eq(chatEvents.chatThreadId, chatThreads.id))
    .where(runOwnedChatEventForRunCondition({ runId }))
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
