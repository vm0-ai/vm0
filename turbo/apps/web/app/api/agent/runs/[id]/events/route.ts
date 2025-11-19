import { NextRequest } from "next/server";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { agentRunEvents } from "../../../../../../src/db/schema/agent-run-event";
import { eq, gt, and } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../../src/lib/api-response";
import {
  NotFoundError,
  UnauthorizedError,
} from "../../../../../../src/lib/errors";

export interface EventsResponse {
  events: Array<{
    sequenceNumber: number;
    eventType: string;
    eventData: unknown;
    createdAt: string;
  }>;
  hasMore: boolean;
  nextSequence: number;
}

/**
 * GET /api/agent/runs/:id/events
 * Poll for agent run events with pagination
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Await params
    const { id } = await params;

    // Parse query parameters
    const { searchParams } = new URL(request.url);
    const since = parseInt(searchParams.get("since") || "0");
    const limit = parseInt(searchParams.get("limit") || "100");

    // Verify run exists and belongs to user
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, id))
      .limit(1);

    if (!run || run.userId !== userId) {
      throw new NotFoundError("Agent run");
    }

    // Query events from database
    const events = await globalThis.services.db
      .select()
      .from(agentRunEvents)
      .where(
        and(
          eq(agentRunEvents.runId, id),
          gt(agentRunEvents.sequenceNumber, since),
        ),
      )
      .orderBy(agentRunEvents.sequenceNumber)
      .limit(limit);

    // Calculate nextSequence and hasMore
    const hasMore = events.length === limit;
    const nextSequence =
      events.length > 0 ? events[events.length - 1]!.sequenceNumber : since;

    // Format response
    const response: EventsResponse = {
      events: events.map((e) => ({
        sequenceNumber: e.sequenceNumber,
        eventType: e.eventType,
        eventData: e.eventData,
        createdAt: e.createdAt.toISOString(),
      })),
      hasMore,
      nextSequence,
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
