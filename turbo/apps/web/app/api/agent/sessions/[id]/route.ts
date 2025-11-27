import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import { agentSessionService } from "../../../../../src/lib/agent-session";

interface RouteParams {
  params: Promise<{ id: string }>;
}

/**
 * GET /api/agent/sessions/:id
 * Get a specific agent session with conversation data
 */
export async function GET(_request: NextRequest, { params }: RouteParams) {
  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { id } = await params;

    // Get session with conversation data
    const session = await agentSessionService.getByIdWithConversation(id);

    if (!session) {
      throw new NotFoundError("Agent session");
    }

    // Verify ownership
    if (session.userId !== userId) {
      throw new UnauthorizedError("Agent session does not belong to user");
    }

    return successResponse({ session }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/agent/sessions/:id
 * Delete an agent session
 */
export async function DELETE(_request: NextRequest, { params }: RouteParams) {
  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    const { id } = await params;

    // Get session to verify ownership
    const session = await agentSessionService.getById(id);

    if (!session) {
      throw new NotFoundError("Agent session");
    }

    // Verify ownership
    if (session.userId !== userId) {
      throw new UnauthorizedError("Agent session does not belong to user");
    }

    // Delete session
    await agentSessionService.delete(id);

    return successResponse({ deleted: true }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
