import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentConfigs } from "../../../../src/db/schema/agent-config";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { e2bService } from "../../../../src/lib/e2b";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../../src/lib/auth/sandbox-token";
import {
  successResponse,
  errorResponse,
} from "../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../src/lib/errors";
import type {
  CreateAgentRunRequest,
  CreateAgentRunResponse,
} from "../../../../src/types/agent-run";

/**
 * POST /api/agent/runs
 * Create and execute an agent run
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
    const body: CreateAgentRunRequest = await request.json();

    if (!body.agentConfigId) {
      throw new BadRequestError("Missing agentConfigId");
    }

    if (!body.prompt) {
      throw new BadRequestError("Missing prompt");
    }

    console.log(`[API] Creating run for config: ${body.agentConfigId}`);

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

    // Create run record in database
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        agentConfigId: body.agentConfigId,
        status: "pending",
        prompt: body.prompt,
        dynamicVars: body.dynamicVars || null,
      })
      .returning();

    if (!run) {
      throw new Error("Failed to create run record");
    }

    console.log(`[API] Created run record: ${run.id}`);

    // Generate temporary bearer token for E2B sandbox
    const sandboxToken = await generateSandboxToken(userId, run.id);
    console.log(`[API] Generated sandbox token for run: ${run.id}`);

    // Update run status to 'running' before starting E2B execution
    await globalThis.services.db
      .update(agentRuns)
      .set({
        status: "running",
        startedAt: new Date(),
      })
      .where(eq(agentRuns.id, run.id));

    // Execute in E2B asynchronously (don't await)
    e2bService
      .createRun(run.id, {
        agentConfigId: body.agentConfigId,
        prompt: body.prompt,
        dynamicVars: body.dynamicVars,
        sandboxToken,
      })
      .then((result) => {
        // Update run with results on success
        return globalThis.services.db
          .update(agentRuns)
          .set({
            status: result.status,
            sandboxId: result.sandboxId,
            result: {
              output: result.output,
              executionTimeMs: result.executionTimeMs,
            },
            error: result.error || null,
            completedAt: result.completedAt || new Date(),
          })
          .where(eq(agentRuns.id, run.id));
      })
      .then(() => {
        console.log(`[API] Run ${run.id} completed successfully`);
      })
      .catch((error) => {
        // Update run with error on failure
        console.error(`[API] Run ${run.id} failed:`, error);
        return globalThis.services.db
          .update(agentRuns)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : "Unknown error",
            completedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));
      });

    // Return response immediately with 'running' status
    const response: CreateAgentRunResponse = {
      runId: run.id,
      status: "running",
      createdAt: run.createdAt.toISOString(),
    };

    return successResponse(response, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
