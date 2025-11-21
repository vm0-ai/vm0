import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentCheckpoints } from "../../../../../src/db/schema/agent-checkpoint";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";

/**
 * GET /api/agent/checkpoints/:id
 * Get checkpoint by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { id } = await params;

    const [checkpoint] = await globalThis.services.db
      .select()
      .from(agentCheckpoints)
      .where(eq(agentCheckpoints.id, id))
      .limit(1);

    if (!checkpoint) {
      throw new NotFoundError("Checkpoint");
    }

    return successResponse(checkpoint);
  } catch (error) {
    return errorResponse(error);
  }
}
