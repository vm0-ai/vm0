import { NextRequest } from "next/server";
import { initServices } from "../../../src/lib/init-services";
import { agentConfigs } from "../../../src/db/schema/agent-config";
import { agentRuntimes } from "../../../src/db/schema/agent-runtime";
import { eq } from "drizzle-orm";
import { e2bService } from "../../../src/lib/e2b";
import { getUserId } from "../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../src/lib/auth/sandbox-token";
import { successResponse, errorResponse } from "../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../src/lib/errors";
import type {
  CreateAgentRuntimeRequest,
  CreateAgentRuntimeResponse,
} from "../../../src/types/agent-runtime";

/**
 * POST /api/agent-runtimes
 * Create and execute an agent runtime
 */
export async function POST(request: NextRequest) {
  try {
    // Initialize services
    initServices();

    // Authenticate
    const userId = await getUserId();
    if (!userId) {
      throw new UnauthorizedError("Not authenticated");
    }

    // Parse request body
    const body: CreateAgentRuntimeRequest = await request.json();

    if (!body.agentConfigId) {
      throw new BadRequestError("Missing agentConfigId");
    }

    if (!body.prompt) {
      throw new BadRequestError("Missing prompt");
    }

    console.log(`[API] Creating runtime for config: ${body.agentConfigId}`);

    // Fetch agent config from database
    const [config] = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, body.agentConfigId))
      .limit(1);

    if (!config) {
      throw new NotFoundError("Agent config");
    }

    console.log(`[API] Found agent config: ${config.id}`);

    // Create runtime record in database
    const [runtime] = await globalThis.services.db
      .insert(agentRuntimes)
      .values({
        userId,
        agentConfigId: body.agentConfigId,
        status: "pending",
        prompt: body.prompt,
        dynamicVars: body.dynamicVars || null,
      })
      .returning();

    if (!runtime) {
      throw new Error("Failed to create runtime record");
    }

    console.log(`[API] Created runtime record: ${runtime.id}`);

    // Generate temporary bearer token for E2B sandbox
    const sandboxToken = await generateSandboxToken(userId, runtime.id);
    console.log(`[API] Generated sandbox token for runtime: ${runtime.id}`);

    // Execute in E2B (pass the runtime ID and sandbox token)
    try {
      const result = await e2bService.createRuntime(runtime.id, {
        agentConfigId: body.agentConfigId,
        prompt: body.prompt,
        dynamicVars: body.dynamicVars,
        sandboxToken,
      });

      // Update runtime with results
      await globalThis.services.db
        .update(agentRuntimes)
        .set({
          status: result.status,
          sandboxId: result.sandboxId,
          result: {
            output: result.output,
            executionTimeMs: result.executionTimeMs,
          },
          error: result.error || null,
          startedAt: result.createdAt,
          completedAt: result.completedAt || new Date(),
        })
        .where(eq(agentRuntimes.id, runtime.id));

      console.log(
        `[API] Runtime ${runtime.id} completed with status: ${result.status}`,
      );

      // Return response
      const response: CreateAgentRuntimeResponse = {
        runtimeId: runtime.id,
        status: result.status,
        sandboxId: result.sandboxId,
        output: result.output,
        error: result.error,
        executionTimeMs: result.executionTimeMs,
        createdAt: runtime.createdAt.toISOString(),
      };

      return successResponse(response, 201);
    } catch (error) {
      // If E2B execution fails, mark runtime as failed
      await globalThis.services.db
        .update(agentRuntimes)
        .set({
          status: "failed",
          error: error instanceof Error ? error.message : "Unknown error",
          completedAt: new Date(),
        })
        .where(eq(agentRuntimes.id, runtime.id));

      throw error;
    }
  } catch (error) {
    return errorResponse(error);
  }
}
