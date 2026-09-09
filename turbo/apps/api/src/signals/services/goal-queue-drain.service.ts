import { agents } from "@okouai/db/schema/agent";
import { chatThreads } from "@okouai/db/schema/chat-thread";
import { command } from "ccstate";
import { eq } from "drizzle-orm";

import { logger } from "../../lib/log";
import { writeDb$ } from "../external/db";
import { publishChatThreadMessageCreatedSafely } from "../external/realtime";
import { revokePendingGoalQueueEvents } from "./chat-goal-queue.service";

const log = logger("api:goal-queue-drain");

export const drainGoalQueueForThread$ = command(
  async ({ set }, chatThreadId: string, signal: AbortSignal): Promise<void> => {
    const db = set(writeDb$);
    const revoked = await revokePendingGoalQueueEvents(db, chatThreadId);
    signal.throwIfAborted();
    if (revoked === 0) {
      return;
    }
    log.debug("Retired goal queue inputs revoked", { chatThreadId, revoked });
    const [thread] = await db
      .select({ userId: chatThreads.userId, orgId: agents.orgId })
      .from(chatThreads)
      .innerJoin(agents, eq(agents.id, chatThreads.agentId))
      .where(eq(chatThreads.id, chatThreadId));
    signal.throwIfAborted();
    if (thread) {
      await publishChatThreadMessageCreatedSafely({
        ...thread,
        threadId: chatThreadId,
      });
      signal.throwIfAborted();
    }
  },
);
