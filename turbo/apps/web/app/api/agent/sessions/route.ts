import { initServices } from "../../../../src/lib/init-services";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import { UnauthorizedError } from "../../../../src/lib/errors";
import { agentSessionService } from "../../../../src/lib/agent-session";

/**
 * GET /api/agent/sessions
 * List all agent sessions for the authenticated user
 */
export async function GET() {
  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Get all sessions for user
    const sessions = await agentSessionService.getByUserId(userId);

    return successResponse({ sessions }, 200);
  } catch (error) {
    return errorResponse(error);
  }
}
