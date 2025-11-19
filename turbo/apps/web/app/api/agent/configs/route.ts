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
import { eq, and } from "drizzle-orm";

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

    // Validate agent.name
    const agentName = body.config.agent?.name;
    if (!agentName) {
      throw new BadRequestError("Missing agent.name in config");
    }

    // Validate name format: 3-64 chars, alphanumeric and hyphens, start/end with alphanumeric
    const nameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{1,62}[a-zA-Z0-9])?$/;
    if (!nameRegex.test(agentName)) {
      throw new BadRequestError(
        "Invalid agent.name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
      );
    }

    // Check if config exists for this user + name
    const existing = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(
        and(eq(agentConfigs.userId, userId), eq(agentConfigs.name, agentName)),
      )
      .limit(1);

    let response: CreateAgentConfigResponse;

    if (existing.length > 0 && existing[0]) {
      // UPDATE existing config
      const [updated] = await globalThis.services.db
        .update(agentConfigs)
        .set({
          config: body.config,
          updatedAt: new Date(),
        })
        .where(eq(agentConfigs.id, existing[0].id))
        .returning({
          id: agentConfigs.id,
          name: agentConfigs.name,
          updatedAt: agentConfigs.updatedAt,
        });

      if (!updated) {
        throw new Error("Failed to update agent config");
      }

      response = {
        configId: updated.id,
        name: updated.name,
        action: "updated",
        updatedAt: updated.updatedAt.toISOString(),
      };

      return successResponse(response, 200);
    } else {
      // INSERT new config
      const [created] = await globalThis.services.db
        .insert(agentConfigs)
        .values({
          userId,
          name: agentName,
          config: body.config,
        })
        .returning({
          id: agentConfigs.id,
          name: agentConfigs.name,
          createdAt: agentConfigs.createdAt,
        });

      if (!created) {
        throw new Error("Failed to create agent config");
      }

      response = {
        configId: created.id,
        name: created.name,
        action: "created",
        createdAt: created.createdAt.toISOString(),
      };

      return successResponse(response, 201);
    }
  } catch (error) {
    return errorResponse(error);
  }
}
