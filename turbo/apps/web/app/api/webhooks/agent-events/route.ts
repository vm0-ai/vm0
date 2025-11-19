import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { agentRunEvents } from "../../../../src/db/schema/agent-run-event";
import { eq, max, and } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../src/lib/errors";
import type {
  WebhookRequest,
  WebhookResponse,
} from "../../../../src/types/webhook";

/**
 * POST /api/webhooks/agent-events
 * Receive agent events from E2B sandbox
 */
export async function POST(request: NextRequest) {
  try {
    // Initialize services
    initServices();

    // Authenticate using bearer token
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Parse request body
    const body: WebhookRequest = await request.json();

    if (!body.runId) {
      throw new BadRequestError("Missing runId");
    }

    if (!body.events || !Array.isArray(body.events)) {
      throw new BadRequestError("Missing or invalid events array");
    }

    if (body.events.length === 0) {
      throw new BadRequestError("Events array cannot be empty");
    }

    console.log(
      `[Webhook] Received ${body.events.length} events for run ${body.runId} from user ${userId}`,
    );

    // Verify run exists and belongs to the authenticated user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      throw new NotFoundError("Agent run");
    }

    // Get the last sequence number for this run
    const [lastEvent] = await globalThis.services.db
      .select({ maxSeq: max(agentRunEvents.sequenceNumber) })
      .from(agentRunEvents)
      .where(eq(agentRunEvents.runId, body.runId));

    const lastSequence = lastEvent?.maxSeq ?? 0;

    // Prepare events for insertion
    const eventsToInsert = body.events.map((event, index) => ({
      runId: body.runId,
      sequenceNumber: lastSequence + index + 1,
      eventType: event.type,
      eventData: event,
    }));

    // Insert events in batch
    await globalThis.services.db.insert(agentRunEvents).values(eventsToInsert);

    const firstSequence = lastSequence + 1;
    const lastInsertedSequence = lastSequence + body.events.length;

    console.log(
      `[Webhook] Stored events ${firstSequence}-${lastInsertedSequence} for run ${body.runId}`,
    );

    // Return response
    const response: WebhookResponse = {
      received: body.events.length,
      firstSequence,
      lastSequence: lastInsertedSequence,
    };

    return successResponse(response, 200);
  } catch (error) {
    console.error("[Webhook] Error:", error);
    return errorResponse(error);
  }
}
