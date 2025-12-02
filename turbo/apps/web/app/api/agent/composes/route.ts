import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import { BadRequestError, UnauthorizedError } from "../../../../src/lib/errors";
import type {
  CreateAgentComposeRequest,
  CreateAgentComposeResponse,
  AgentComposeYaml,
} from "../../../../src/types/agent-compose";
import { eq, and } from "drizzle-orm";
import { extractUnexpandedVars } from "../../../../src/lib/config-validator";
import { computeComposeVersionId } from "../../../../src/lib/agent-compose/content-hash";

/**
 * GET /api/agent/composes?name={agentName}
 * Get agent compose by name with HEAD version content
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

    // Query compose by userId + name
    const composes = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(eq(agentComposes.userId, userId), eq(agentComposes.name, name)),
      )
      .limit(1);

    if (composes.length === 0) {
      return errorResponse(
        new BadRequestError(`Agent compose not found: ${name}`),
      );
    }

    const compose = composes[0];
    if (!compose) {
      return errorResponse(
        new BadRequestError(`Agent compose not found: ${name}`),
      );
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

    return successResponse({
      id: compose.id,
      name: compose.name,
      headVersionId: compose.headVersionId,
      content,
      createdAt: compose.createdAt.toISOString(),
      updatedAt: compose.updatedAt.toISOString(),
    });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/agent/composes
 * Create a new agent compose version (content-addressed)
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
    const body: CreateAgentComposeRequest = await request.json();

    // Basic validation
    const { content } = body;
    if (!content) {
      throw new BadRequestError("Missing content");
    }

    if (!content.version) {
      throw new BadRequestError("Missing content.version");
    }

    // Validate agents is an object (not array)
    if (!content.agents || typeof content.agents !== "object") {
      throw new BadRequestError("Missing agents object in content");
    }

    if (Array.isArray(content.agents)) {
      throw new BadRequestError(
        "agents must be an object, not an array. Use format: agents: { agent-name: { ... } }",
      );
    }

    const agentKeys = Object.keys(content.agents);
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
    const unexpandedVars = extractUnexpandedVars(content);
    if (unexpandedVars.length > 0) {
      throw new BadRequestError(
        `Configuration contains unexpanded environment variables: ${unexpandedVars.join(", ")}`,
      );
    }

    // Compute content-addressable version ID
    const versionId = computeComposeVersionId(content);

    // Check if compose exists for this user + name
    const existing = await globalThis.services.db
      .select()
      .from(agentComposes)
      .where(
        and(
          eq(agentComposes.userId, userId),
          eq(agentComposes.name, agentName),
        ),
      )
      .limit(1);

    let composeId: string;
    let isNewCompose = false;

    if (existing.length > 0 && existing[0]) {
      // Use existing compose
      composeId = existing[0].id;
    } else {
      // Create new compose metadata
      const [created] = await globalThis.services.db
        .insert(agentComposes)
        .values({
          userId,
          name: agentName,
        })
        .returning({ id: agentComposes.id });

      if (!created) {
        throw new Error("Failed to create agent compose");
      }

      composeId = created.id;
      isNewCompose = true;
    }

    // Check if this exact version already exists
    const existingVersion = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, versionId))
      .limit(1);

    let action: "created" | "existing";

    if (existingVersion.length > 0) {
      // Version already exists (content deduplication)
      action = "existing";
    } else {
      // Create new version
      await globalThis.services.db.insert(agentComposeVersions).values({
        id: versionId,
        composeId,
        content,
        createdBy: userId,
      });

      action = "created";
    }

    // Update HEAD pointer to new version
    await globalThis.services.db
      .update(agentComposes)
      .set({
        headVersionId: versionId,
        updatedAt: new Date(),
      })
      .where(eq(agentComposes.id, composeId));

    const response: CreateAgentComposeResponse = {
      composeId,
      name: agentName,
      versionId,
      action,
      updatedAt: new Date().toISOString(),
    };

    return successResponse(response, isNewCompose ? 201 : 200);
  } catch (error) {
    return errorResponse(error);
  }
}
