import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../../src/db/schema/agent-compose";
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
 * Get agent compose by ID with HEAD version content
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

    // Get HEAD version content if available
    let content: AgentComposeYaml | null = null;
    if (compose.headVersionId) {
      const versions = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, compose.headVersionId))
        .limit(1);

      if (versions.length > 0 && versions[0]) {
        content = versions[0].content as AgentComposeYaml;
      }
    }

    // Return response
    const response: GetAgentComposeResponse = {
      id: compose.id,
      name: compose.name,
      headVersionId: compose.headVersionId,
      content,
      createdAt: compose.createdAt.toISOString(),
      updatedAt: compose.updatedAt.toISOString(),
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
