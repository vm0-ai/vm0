import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentConfigs } from "../../../../src/db/schema/agent-config";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import { BadRequestError, UnauthorizedError } from "../../../../src/lib/errors";
import type {
  CreateAgentConfigRequest,
  CreateAgentConfigResponse,
} from "../../../../src/types/agent-config";

/**
 * POST /api/agent-configs
 * Create a new agent config
 */
export async function POST(request: NextRequest) {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Parse request body
    const body: CreateAgentConfigRequest = await request.json();

    // Basic validation
    if (!body.config) {
      throw new BadRequestError("Missing config");
    }

    if (!body.config.version) {
      throw new BadRequestError("Missing config.version");
    }

    if (!body.config.agent) {
      throw new BadRequestError("Missing config.agent");
    }

    // Insert into database
    const results = await globalThis.services.db
      .insert(agentConfigs)
      .values({
        userId,
        config: body.config,
      })
      .returning({
        id: agentConfigs.id,
        createdAt: agentConfigs.createdAt,
      });

    const result = results[0];
    if (!result) {
      throw new Error("Failed to create agent config");
    }

    // Return response
    const response: CreateAgentConfigResponse = {
      agentConfigId: result.id,
      createdAt: result.createdAt.toISOString(),
    };

    return successResponse(response, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
