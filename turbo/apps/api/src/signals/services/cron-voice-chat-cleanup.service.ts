import { voiceChatSessions } from "@vm0/db/schema/voice-chat";
import { command } from "ccstate";
import { and, desc, eq, inArray, lt } from "drizzle-orm";

import { nowDate } from "../../lib/time";
import { writeDb$ } from "../external/db";

const REASONER_STUCK_MS = 5 * 60 * 1000;
const BATCH_LIMIT = 50;

export const resetStuckVoiceChatReasoners$ = command(
  async ({ set }, signal: AbortSignal): Promise<readonly string[]> => {
    const db = set(writeDb$);
    const reasonerStuckThreshold = nowDate();
    reasonerStuckThreshold.setTime(
      reasonerStuckThreshold.getTime() - REASONER_STUCK_MS,
    );

    const stuckReasonerIds = db
      .select({ id: voiceChatSessions.id })
      .from(voiceChatSessions)
      .where(
        and(
          eq(voiceChatSessions.reasoningStatus, "running"),
          lt(voiceChatSessions.lastSummaryAt, reasonerStuckThreshold),
        ),
      )
      .orderBy(
        desc(voiceChatSessions.lastSummaryAt),
        desc(voiceChatSessions.createdAt),
      )
      .limit(BATCH_LIMIT);

    const recoveredReasoners = await db
      .update(voiceChatSessions)
      .set({ reasoningStatus: "idle" })
      .where(
        and(
          eq(voiceChatSessions.reasoningStatus, "running"),
          lt(voiceChatSessions.lastSummaryAt, reasonerStuckThreshold),
          inArray(voiceChatSessions.id, stuckReasonerIds),
        ),
      )
      .returning({ id: voiceChatSessions.id });
    signal.throwIfAborted();

    return recoveredReasoners.map((row) => {
      return row.id;
    });
  },
);
