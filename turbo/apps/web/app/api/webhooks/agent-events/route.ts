import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuntimes } from "../../../../src/db/schema/agent-runtime";
import { agentRuntimeEvents } from "../../../../src/db/schema/agent-runtime-event";
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

    if (!body.runtimeId) {
      throw new BadRequestError("Missing runtimeId");
    }

    if (!body.events || !Array.isArray(body.events)) {
      throw new BadRequestError("Missing or invalid events array");
    }

    if (body.events.length === 0) {
      throw new BadRequestError("Events array cannot be empty");
    }

    console.log(
      `[Webhook] Received ${body.events.length} events for runtime ${body.runtimeId} from user ${userId}`,
    );

    // Verify runtime exists and belongs to the authenticated user
    const [runtime] = await globalThis.services.db
      .select()
      .from(agentRuntimes)
      .where(
        and(
          eq(agentRuntimes.id, body.runtimeId),
          eq(agentRuntimes.userId, userId),
        ),
      )
      .limit(1);

    if (!runtime) {
      throw new NotFoundError("Agent runtime");
    }

    // Get the last sequence number for this runtime
    const [lastEvent] = await globalThis.services.db
      .select({ maxSeq: max(agentRuntimeEvents.sequenceNumber) })
      .from(agentRuntimeEvents)
      .where(eq(agentRuntimeEvents.runtimeId, body.runtimeId));

    const lastSequence = lastEvent?.maxSeq ?? 0;

    // Prepare events for insertion
    const eventsToInsert = body.events.map((event, index) => ({
      runtimeId: body.runtimeId,
      sequenceNumber: lastSequence + index + 1,
      eventType: event.type,
      eventData: event,
    }));

    // Insert events in batch
    await globalThis.services.db
      .insert(agentRuntimeEvents)
      .values(eventsToInsert);

    const firstSequence = lastSequence + 1;
    const lastInsertedSequence = lastSequence + body.events.length;

    console.log(
      `[Webhook] Stored events ${firstSequence}-${lastInsertedSequence} for runtime ${body.runtimeId}`,
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
