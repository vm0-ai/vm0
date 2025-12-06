import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhooks:heartbeat");

interface HeartbeatRequest {
  runId: string;
}

interface HeartbeatResponse {
  ok: boolean;
}

/**
 * POST /api/webhooks/agent/heartbeat
 * Receive heartbeat signals from E2B sandbox to indicate agent is still alive
 */
export async function POST(request: NextRequest) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const body: HeartbeatRequest = await request.json();

    if (!body.runId) {
      throw new BadRequestError("Missing runId");
    }

    const result = await globalThis.services.db
      .update(agentRuns)
      .set({ lastHeartbeatAt: new Date() })
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .returning({ id: agentRuns.id });

    if (result.length === 0) {
      throw new NotFoundError("Agent run");
    }

    log.debug(`Updated heartbeat for run ${body.runId}`);

    const response: HeartbeatResponse = { ok: true };
    return successResponse(response, 200);
  } catch (error) {
    log.error("Heartbeat error:", error);
    return errorResponse(error);
  }
}
