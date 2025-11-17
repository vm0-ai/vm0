import { NextRequest } from "next/server";
import { eq } from "drizzle-orm";
import { initServices } from "../../../../src/lib/init-services";
import { agentConfigs } from "../../../../src/db/schema/agent-config";
import { authenticate } from "../../../../src/lib/middleware/auth";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import { NotFoundError } from "../../../../src/lib/errors";
import type {
  GetAgentConfigResponse,
  AgentConfigYaml,
} from "../../../../src/types/agent-config";

/**
 * GET /api/agent-configs/:id
 * Get agent config by ID
 */
export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    await authenticate(request);

    // Await params (Next.js 15 requirement)
    const { id } = await params;

    // Query database
    const [config] = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, id))
      .limit(1);

    if (!config) {
      throw new NotFoundError("Agent config");
    }

    // Return response
    const response: GetAgentConfigResponse = {
      id: config.id,
      config: config.config as AgentConfigYaml,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    };

    return successResponse(response);
  } catch (error) {
    return errorResponse(error);
  }
}
