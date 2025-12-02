import { NextRequest } from "next/server";
import { initServices } from "../../../../src/lib/init-services";
import {
  agentComposes,
  agentComposeVersions,
} from "../../../../src/db/schema/agent-compose";
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
  UnifiedRunRequest,
  CreateAgentRunResponse,
} from "../../../../src/types/agent-run";
import type { AgentComposeYaml } from "../../../../src/types/agent-compose";
import { sendVm0ErrorEvent } from "../../../../src/lib/events";
import { extractTemplateVars } from "../../../../src/lib/config-validator";

/**
 * POST /api/agent/runs
 *
 * Unified API for creating and executing agent runs.
 * Supports three modes via optional parameters:
 *
 * 1. New run: Provide agentComposeId or agentComposeVersionId, artifactName, prompt
 * 2. Checkpoint resume: Provide checkpointId, prompt (expands to snapshot parameters)
 * 3. Session continue: Provide sessionId, prompt (uses latest artifact version)
 *
 * Parameters can be combined for fine-grained control:
 * - volumeVersions: Override volume versions (volume name -> version)
 * - artifactVersion: Override artifact version
 * - templateVars: Template variables
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
    const body: UnifiedRunRequest = await request.json();

    // Validate prompt is provided
    if (!body.prompt) {
      throw new BadRequestError("Missing prompt");
    }

    // Validate mutually exclusive shortcuts
    if (body.checkpointId && body.sessionId) {
      throw new BadRequestError(
        "Cannot specify both checkpointId and sessionId. Use one or the other.",
      );
    }

    // Determine run mode and validate required parameters
    const isCheckpointResume = !!body.checkpointId;
    const isSessionContinue = !!body.sessionId;
    const isNewRun = !isCheckpointResume && !isSessionContinue;

    // For new runs, require either agentComposeId or agentComposeVersionId, and artifactName
    if (isNewRun) {
      if (!body.agentComposeId && !body.agentComposeVersionId) {
        throw new BadRequestError(
          "Missing agentComposeId or agentComposeVersionId. For new runs, one is required.",
        );
      }
      if (!body.artifactName) {
        throw new BadRequestError(
          "Missing artifactName. Use --artifact-name flag to specify artifact.",
        );
      }
    }

    console.log(
      `[API] Creating run - mode: ${isCheckpointResume ? "checkpoint" : isSessionContinue ? "session" : "new"}`,
    );
    console.log(
      `[API] Request body.volumeVersions=${JSON.stringify(body.volumeVersions)}`,
    );

    // Resolve compose version ID and content for the run
    let agentComposeVersionId: string;
    let agentComposeName: string | undefined;
    let composeContent: AgentComposeYaml | undefined;

    if (isNewRun) {
      if (body.agentComposeVersionId) {
        // Explicit version ID provided - use directly
        agentComposeVersionId = body.agentComposeVersionId;

        // Fetch version for validation
        const [version] = await globalThis.services.db
          .select()
          .from(agentComposeVersions)
          .where(eq(agentComposeVersions.id, agentComposeVersionId))
          .limit(1);

        if (!version) {
          throw new NotFoundError("Agent compose version");
        }

        composeContent = version.content as AgentComposeYaml;

        // Get compose name
        const [compose] = await globalThis.services.db
          .select()
          .from(agentComposes)
          .where(eq(agentComposes.id, version.composeId))
          .limit(1);

        agentComposeName = compose?.name || undefined;
      } else {
        // Resolve compose ID to HEAD version
        const composeId = body.agentComposeId!;

        const [compose] = await globalThis.services.db
          .select()
          .from(agentComposes)
          .where(eq(agentComposes.id, composeId))
          .limit(1);

        if (!compose) {
          throw new NotFoundError("Agent compose");
        }

        if (!compose.headVersionId) {
          throw new BadRequestError(
            "Agent compose has no versions. Run 'vm0 build' first.",
          );
        }

        agentComposeVersionId = compose.headVersionId;
        agentComposeName = compose.name || undefined;

        // Fetch version content
        const [version] = await globalThis.services.db
          .select()
          .from(agentComposeVersions)
          .where(eq(agentComposeVersions.id, agentComposeVersionId))
          .limit(1);

        if (!version) {
          throw new NotFoundError("Agent compose version");
        }

        composeContent = version.content as AgentComposeYaml;
      }

      // Validate template variables for new runs
      if (composeContent) {
        const requiredVars = extractTemplateVars(composeContent);
        const providedVars = body.templateVars || {};
        const missingVars = requiredVars.filter(
          (varName) => providedVars[varName] === undefined,
        );

        if (missingVars.length > 0) {
          throw new BadRequestError(
            `Missing required template variables: ${missingVars.join(", ")}`,
          );
        }
      }
    } else if (isCheckpointResume) {
      // Validate checkpoint first to get agentComposeVersionId
      const sessionData = await runService.validateCheckpoint(
        body.checkpointId!,
        userId,
      );
      agentComposeVersionId = sessionData.agentComposeVersionId;

      // Get compose name for metadata
      const [version] = await globalThis.services.db
        .select()
        .from(agentComposeVersions)
        .where(eq(agentComposeVersions.id, agentComposeVersionId))
        .limit(1);

      if (version) {
        const [compose] = await globalThis.services.db
          .select()
          .from(agentComposes)
          .where(eq(agentComposes.id, version.composeId))
          .limit(1);
        agentComposeName = compose?.name || undefined;
      }
    } else {
      // Session continue - resolve to HEAD version of session's compose
      const sessionData = await runService.validateAgentSession(
        body.sessionId!,
        userId,
      );

      // Get compose and resolve to HEAD version
      const [compose] = await globalThis.services.db
        .select()
        .from(agentComposes)
        .where(eq(agentComposes.id, sessionData.agentComposeId))
        .limit(1);

      if (!compose) {
        throw new NotFoundError("Agent compose for session");
      }

      if (!compose.headVersionId) {
        throw new BadRequestError(
          "Agent compose has no versions. Run 'vm0 build' first.",
        );
      }

      agentComposeVersionId = compose.headVersionId;
      agentComposeName = compose.name || undefined;
    }

    console.log(
      `[API] Resolved agentComposeVersionId: ${agentComposeVersionId}`,
    );

    // Create run record in database
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        agentComposeVersionId,
        status: "pending",
        prompt: body.prompt,
        templateVars: body.templateVars || null,
        resumedFromCheckpointId: body.checkpointId || null,
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

    // Build execution context and start sandbox (fire-and-forget)
    // vm0_start event is sent by E2B service after storage preparation
    // Final status will be updated by webhook when run-agent.sh completes
    try {
      const context = await runService.buildExecutionContext({
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
        agentComposeVersionId:
          body.agentComposeVersionId || agentComposeVersionId,
        conversationId: body.conversationId,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        templateVars: body.templateVars,
        volumeVersions: body.volumeVersions,
        prompt: body.prompt,
        runId: run.id,
        sandboxToken,
        userId,
        // Metadata for vm0_start event (sent by E2B service)
        agentName: agentComposeName,
        resumedFromCheckpointId: body.checkpointId,
        continuedFromSessionId: body.sessionId,
      });

      // Start execution - returns immediately after sandbox is prepared
      // Agent execution continues in background (fire-and-forget)
      const result = await runService.executeRun(context);

      // Update run with sandboxId
      await globalThis.services.db
        .update(agentRuns)
        .set({
          sandboxId: result.sandboxId,
        })
        .where(eq(agentRuns.id, run.id));

      console.log(
        `[API] Run ${run.id} started successfully (sandbox: ${result.sandboxId})`,
      );
    } catch (error) {
      // Extract error message - E2B CommandExitError includes result with stderr
      let errorMessage =
        error instanceof Error ? error.message : "Unknown error";

      // Check if error has result property (E2B CommandExitError)
      const errorWithResult = error as { result?: { stderr?: string } };
      if (errorWithResult.result?.stderr) {
        errorMessage = errorWithResult.result.stderr;
      }

      // Update run with error on preparation failure
      console.error(`[API] Run ${run.id} preparation failed:`, errorMessage);
      await globalThis.services.db
        .update(agentRuns)
        .set({
          status: "failed",
          error: errorMessage,
          completedAt: new Date(),
        })
        .where(eq(agentRuns.id, run.id));

      // Send vm0_error event
      await sendVm0ErrorEvent({
        runId: run.id,
        error: errorMessage,
        errorType: "sandbox_error",
      });

      // Return error response for preparation failures
      const response: CreateAgentRunResponse = {
        runId: run.id,
        status: "failed",
        createdAt: run.createdAt.toISOString(),
      };
      return successResponse(response, 201);
    }

    // Return response with 'running' status
    // Final status will be updated by webhook when agent completes
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
