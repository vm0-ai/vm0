import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import { agentConfigs } from "../../../../src/db/schema/agent-config";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { runService } from "../../../../src/lib/run";
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
import {
  sendVm0StartEvent,
  sendVm0ErrorEvent,
} from "../../../../src/lib/events";
import { extractTemplateVars } from "../../../../src/lib/config-validator";

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

    // Validate template variables
    const requiredVars = extractTemplateVars(config.config);
    const providedVars = body.dynamicVars || {};
    const missingVars = requiredVars.filter(
      (varName) => providedVars[varName] === undefined,
    );

    if (missingVars.length > 0) {
      throw new BadRequestError(
        `Missing required template variables: ${missingVars.join(", ")}`,
      );
    }

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

    // Send vm0_start event
    await sendVm0StartEvent({
      runId: run.id,
      agentConfigId: body.agentConfigId,
      agentName: config.name || undefined,
      prompt: body.prompt,
      dynamicVars: body.dynamicVars,
    });

    // Execute in E2B asynchronously (don't await)
    // First create execution context
    runService
      .createRunContext(
        run.id,
        body.agentConfigId,
        body.prompt,
        sandboxToken,
        body.dynamicVars,
        config.config,
      )
      .then((context) => runService.executeRun(context))
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
      .catch(async (error) => {
        // Update run with error on failure
        console.error(`[API] Run ${run.id} failed:`, error);
        await globalThis.services.db
          .update(agentRuns)
          .set({
            status: "failed",
            error: error instanceof Error ? error.message : "Unknown error",
            completedAt: new Date(),
          })
          .where(eq(agentRuns.id, run.id));

        // Send vm0_error event
        await sendVm0ErrorEvent({
          runId: run.id,
          error: error instanceof Error ? error.message : "Unknown error",
          errorType: "sandbox_error",
        });
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
