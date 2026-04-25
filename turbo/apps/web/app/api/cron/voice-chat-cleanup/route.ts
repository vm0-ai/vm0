import { NextResponse, after } from "next/server";
import { inArray, and, lt, eq } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";
import { voiceChatSessions } from "@vm0/db/schema/voice-chat";
import { triggerReasoning } from "../../../../src/lib/zero/voice-chat/trigger-reasoning";

export const maxDuration = 60;

const log = logger("cron:voice-chat-cleanup");

// Voice-chat sessions are stateless (no active/ended/timeout), so there is
// nothing to "time out" here. The reasoner CAS lock still needs a stuck-
// recovery tick, though — that's the only branch left.
const REASONER_STUCK_MS = 5 * 60 * 1000; // 5 minutes
const BATCH_LIMIT = 50;

export async function GET(request: Request): Promise<Response> {
  initServices();

  const authHeader = request.headers.get("authorization");
  const cronSecret = env().CRON_SECRET;
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return NextResponse.json(
      { error: { message: "Invalid cron secret", code: "UNAUTHORIZED" } },
      { status: 401 },
    );
  }

  const now = new Date();

  // === voice-chat reasoner stuck recovery ===
  // LIMIT 50 per tick caps worst-case runtime under catastrophic backlog.
  const reasonerStuckThreshold = new Date(now.getTime() - REASONER_STUCK_MS);

  const stuckReasonerIds = globalThis.services.db
    .select({ id: voiceChatSessions.id })
    .from(voiceChatSessions)
    .where(
      and(
        eq(voiceChatSessions.reasoningStatus, "running"),
        lt(voiceChatSessions.lastSummaryAt, reasonerStuckThreshold),
      ),
    )
    .limit(BATCH_LIMIT);

  // Belt-and-braces: predicates repeated on the UPDATE itself so a concurrent
  // Reasoner flipping idle→running between subselect eval and row lock under
  // READ COMMITTED cannot get its status reset out from under it.
  const recoveredReasoners = await globalThis.services.db
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

  for (const row of recoveredReasoners) {
    log.warn("Voice-chat reasoner stuck-reset", { sessionId: row.id });
    after(() => {
      return triggerReasoning(row.id);
    });
  }

  return NextResponse.json({
    success: true,
    reasonerReset: recoveredReasoners.length,
  });
}
