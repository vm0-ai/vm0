import { NextRequest } from "next/server";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { agentConfigs } from "../../../../../src/db/schema/agent-config";
import { runService } from "../../../../../src/lib/run";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../../../src/lib/auth/sandbox-token";
import {
  successResponse,
  errorResponse,
} from "../../../../../src/lib/api-response";
import {
  BadRequestError,
  NotFoundError,
  UnauthorizedError,
} from "../../../../../src/lib/errors";
import { eq } from "drizzle-orm";
import {
  sendVm0StartEvent,
  sendVm0ErrorEvent,
} from "../../../../../src/lib/events";

export interface ContinueAgentRunRequest {
  agentSessionId: string;
  prompt: string;
}

export interface ContinueAgentRunResponse {
  runId: string;
  status: string;
  createdAt: string;
}

/**
 * POST /api/agent/runs/continue
 * Continue execution from an agent session (uses latest artifact version)
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
    const body: ContinueAgentRunRequest = await request.json();

    if (!body.agentSessionId) {
      throw new BadRequestError("Missing agentSessionId");
    }

    if (!body.prompt) {
      throw new BadRequestError("Missing prompt");
    }

    console.log(
      `[API] Continuing from session: ${body.agentSessionId} for user ${userId}`,
    );

    // Validate session and get config ID (lightweight validation without full context)
    const sessionData = await runService.validateAgentSession(
      body.agentSessionId,
      userId,
    );

    console.log(
      `[API] Session validated for agent config: ${sessionData.agentConfigId}`,
    );

    // Create run record in database
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        agentConfigId: sessionData.agentConfigId,
        status: "pending",
        prompt: body.prompt,
        templateVars: sessionData.templateVars || null,
      })
      .returning();

    if (!run) {
      throw new NotFoundError("Failed to create run record");
    }

    console.log(
      `[API] Created continue run record: ${run.id} (from session ${body.agentSessionId})`,
    );

    // Generate temporary bearer token for E2B sandbox
    const sandboxToken = await generateSandboxToken(userId, run.id);
    console.log(`[API] Generated sandbox token for continue run: ${run.id}`);

    // Fetch agent config for event metadata
    const [config] = await globalThis.services.db
      .select()
      .from(agentConfigs)
      .where(eq(agentConfigs.id, sessionData.agentConfigId))
      .limit(1);

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
      agentConfigId: sessionData.agentConfigId,
      agentName: config?.name || undefined,
      prompt: body.prompt,
      templateVars: sessionData.templateVars || undefined,
    });

    // Execute in E2B asynchronously (don't await)
    // Create full context with actual run ID and token
    runService
      .createContinueContext(
        run.id,
        body.agentSessionId,
        body.prompt,
        sandboxToken,
        userId,
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
        console.log(`[API] Continue run ${run.id} completed successfully`);
      })
      .catch(async (error) => {
        // Update run with error on failure
        console.error(`[API] Continue run ${run.id} failed:`, error);
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
    const response: ContinueAgentRunResponse = {
      runId: run.id,
      status: "running",
      createdAt: run.createdAt.toISOString(),
    };

    return successResponse(response, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
