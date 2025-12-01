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
import { extractUnexpandedVars } from "../../../../src/lib/config-validator";

/**
 * GET /api/agent/configs?name={agentName}
 * Get agent config by name
 */
export async function GET(request: NextRequest) {
  try {
    // Initialize services at serverless function entry
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Get name from query parameter
    const { searchParams } = new URL(request.url);
    const name = searchParams.get("name");

    if (!name) {
      throw new BadRequestError("Missing name query parameter");
    }

    // Query config by userId + name
    const configs = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(and(eq(agentConfigs.userId, userId), eq(agentConfigs.name, name)))
      .limit(1);

    if (configs.length === 0) {
      return errorResponse(
        new BadRequestError(`Agent config not found: ${name}`),
      );
    }

    const config = configs[0];
    if (!config) {
      return errorResponse(
        new BadRequestError(`Agent config not found: ${name}`),
      );
    }

    return successResponse({
      id: config.id,
      name: config.name,
      config: config.config,
      createdAt: config.createdAt.toISOString(),
      updatedAt: config.updatedAt.toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

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

    // Validate agents is an object (not array)
    if (!body.config.agents || typeof body.config.agents !== "object") {
      throw new BadRequestError("Missing agents object in config");
    }

    if (Array.isArray(body.config.agents)) {
      throw new BadRequestError(
        "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
      );
    }

    const agentKeys = Object.keys(body.config.agents);
    if (agentKeys.length === 0) {
      throw new BadRequestError("agents must have at least one agent defined");
    }

    if (agentKeys.length > 1) {
      throw new BadRequestError(
        "Multiple agents not supported yet. Only one agent allowed.",
      );
    }

    // Get agent name from key (guaranteed to exist due to length check above)
    const agentName = agentKeys[0];
    if (!agentName) {
      throw new BadRequestError("agents must have at least one agent defined");
    }

    // Validate name format: 3-64 chars, alphanumeric and hyphens, start/end with alphanumeric
    const nameRegex = /^[a-zA-Z0-9]([a-zA-Z0-9-]{1,62}[a-zA-Z0-9])?$/;
    if (!nameRegex.test(agentName)) {
      throw new BadRequestError(
        "Invalid agent name format. Must be 3-64 characters, letters, numbers, and hyphens only. Must start and end with letter or number.",
      );
    }

    // Validate that all environment variables are expanded
    const unexpandedVars = extractUnexpandedVars(body.config);
    if (unexpandedVars.length > 0) {
      throw new BadRequestError(
        `Configuration contains unexpanded environment variables: ${unexpandedVars.join(", ")}`,
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
