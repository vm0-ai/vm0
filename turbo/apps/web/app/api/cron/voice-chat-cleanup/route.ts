import { NextResponse } from "next/server";
import { inArray, and, or, lt } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { logger } from "../../../../src/lib/shared/logger";
import { env } from "../../../../src/env";
import {
  voiceChatSessions,
  voiceChatEvents,
} from "../../../../src/db/schema/voice-chat";
import { deleteExpiredPreparations } from "../../../../src/lib/zero/voice-chat/preparation-service";

const log = logger("cron:voice-chat-cleanup");

const STALE_HEARTBEAT_MS = 2 * 60 * 1000; // 2 minutes
const MAX_SESSION_DURATION_MS = 60 * 60 * 1000; // 60 minutes
const PREPARATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

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
  const staleThreshold = new Date(now.getTime() - STALE_HEARTBEAT_MS);
  const timeoutThreshold = new Date(now.getTime() - MAX_SESSION_DURATION_MS);

  const result = await globalThis.services.db
    .update(voiceChatSessions)
    .set({ status: "timeout", endedAt: now })
    .where(
      and(
        inArray(voiceChatSessions.status, ["active", "preparing"]),
        or(
          lt(voiceChatSessions.lastHeartbeatAt, staleThreshold),
          lt(voiceChatSessions.createdAt, timeoutThreshold),
        ),
      ),
    )
    .returning({ id: voiceChatSessions.id });

  if (result.length > 0) {
    await globalThis.services.db.insert(voiceChatEvents).values(
      result.map((r) => {
        return {
          sessionId: r.id,
          source: "system" as const,
          type: "session-end" as const,
        };
      }),
    );
    log.info("Voice chat cleanup completed", { cleaned: result.length });
  }

  // Clean up expired preparations (>24h)
  const expiredPreps = await deleteExpiredPreparations(PREPARATION_TTL_MS);

  return NextResponse.json({
    success: true,
    cleaned: result.length,
    preparationsCleaned: expiredPreps.length,
  });
}
