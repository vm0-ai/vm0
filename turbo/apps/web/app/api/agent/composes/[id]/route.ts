import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import { agentComposes } from "../../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import type {
  GetAgentComposeResponse,
  AgentComposeYaml,
} from "../../../../../src/types/agent-compose";

/**
 * GET /api/agent/composes/:id
 * Get agent compose by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Await params (Next.js 15 requirement)
    const { id } = await params;

    // Query database
    const [compose] = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(eq(agentComposes.id, id))
      .limit(1);

    if (!compose) {
      throw new NotFoundError("Agent compose");
    }

    // Return response
    const response: GetAgentComposeResponse = {
      id: compose.id,
      name: compose.name,
      config: compose.config as AgentComposeYaml,
      createdAt: compose.createdAt.toISOString(),
      updatedAt: compose.updatedAt.toISOString(),
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
