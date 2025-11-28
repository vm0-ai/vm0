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
  UnifiedRunRequest,
  CreateAgentRunResponse,
} from "../../../../src/types/agent-run";
import {
  sendVm0StartEvent,
  sendVm0ErrorEvent,
} from "../../../../src/lib/events";
import { extractTemplateVars } from "../../../../src/lib/config-validator";
import { checkpoints } from "../../../../src/db/schema/checkpoint";
import { agentSessions } from "../../../../src/db/schema/agent-session";
import type {
  ArtifactSnapshot,
  VolumeVersionsSnapshot,
} from "../../../../src/lib/checkpoint/types";

/**
 * POST /api/agent/runs
 *
 * Unified API for creating and executing agent runs.
 * Supports three modes via optional parameters:
 *
 * 1. New run: Provide agentConfigId, artifactName, prompt
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

    // For new runs, require agentConfigId and artifactName
    if (isNewRun) {
      if (!body.agentConfigId) {
        throw new BadRequestError(
          "Missing agentConfigId. For new runs, agentConfigId is required.",
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

    // Determine agentConfigId for run record creation
    // For new runs: from request
    // For checkpoint/session: will be resolved by buildExecutionContext, but we need it early
    let agentConfigId: string;
    let agentConfigName: string | undefined;

    if (isNewRun) {
      agentConfigId = body.agentConfigId!;

      // Fetch config for validation and metadata
      const [config] = await globalThis.services.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, agentConfigId))
        .limit(1);

      if (!config) {
        throw new NotFoundError("Agent config");
      }

      agentConfigName = config.name || undefined;

      // Validate template variables for new runs
      const requiredVars = extractTemplateVars(config.config);
      const providedVars = body.templateVars || {};
      const missingVars = requiredVars.filter(
        (varName) => providedVars[varName] === undefined,
      );

      if (missingVars.length > 0) {
        throw new BadRequestError(
          `Missing required template variables: ${missingVars.join(", ")}`,
        );
      }
    } else if (isCheckpointResume) {
      // Validate checkpoint first to get agentConfigId
      const sessionData = await runService.validateCheckpoint(
        body.checkpointId!,
        userId,
      );
      agentConfigId = sessionData.agentConfigId;

      // Get config name for metadata
      const [config] = await globalThis.services.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, agentConfigId))
        .limit(1);
      agentConfigName = config?.name || undefined;
    } else {
      // Session continue
      const sessionData = await runService.validateAgentSession(
        body.sessionId!,
        userId,
      );
      agentConfigId = sessionData.agentConfigId;

      // Get config name for metadata
      const [config] = await globalThis.services.db
        .select()
        .from(agentConfigs)
        .where(eq(agentConfigs.id, agentConfigId))
        .limit(1);
      agentConfigName = config?.name || undefined;
    }

    console.log(`[API] Resolved agentConfigId: ${agentConfigId}`);

    // Resolve artifact and volume info for vm0_start event
    // artifact format: { artifactName: version }
    let startArtifact: Record<string, string> | undefined;
    let startVolumes: Record<string, string> | undefined;

    if (isCheckpointResume) {
      // Load checkpoint to get artifact and volume info
      const [checkpoint] = await globalThis.services.db
        .select()
        .from(checkpoints)
        .where(eq(checkpoints.id, body.checkpointId!))
        .limit(1);

      if (checkpoint) {
        const artifactSnapshot =
          checkpoint.artifactSnapshot as unknown as ArtifactSnapshot;
        const volumeSnapshot =
          checkpoint.volumeVersionsSnapshot as VolumeVersionsSnapshot | null;

        startArtifact = {
          [artifactSnapshot.artifactName]: artifactSnapshot.artifactVersion,
        };
        // Use request volume overrides if provided, otherwise use snapshot
        startVolumes = body.volumeVersions || volumeSnapshot?.versions;
      }
    } else if (isSessionContinue) {
      // Load session to get artifact info
      const [session] = await globalThis.services.db
        .select()
        .from(agentSessions)
        .where(eq(agentSessions.id, body.sessionId!))
        .limit(1);

      if (session) {
        startArtifact = {
          [session.artifactName]: "latest", // Session continue always uses latest
        };
        startVolumes = body.volumeVersions;
      }
    } else {
      // New run - use request parameters
      if (body.artifactName) {
        startArtifact = {
          [body.artifactName]: body.artifactVersion || "latest",
        };
      }
      startVolumes = body.volumeVersions;
    }

    // Create run record in database
    const [run] = await globalThis.services.db
      .insert(agentRuns)
      .values({
        userId,
        agentConfigId,
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

    // Send vm0_start event with execution context
    await sendVm0StartEvent({
      runId: run.id,
      agentConfigId,
      agentName: agentConfigName,
      prompt: body.prompt,
      templateVars: body.templateVars,
      resumedFromCheckpointId: body.checkpointId,
      continuedFromSessionId: body.sessionId,
      artifact: startArtifact,
      volumes: startVolumes,
    });

    // Execute in E2B asynchronously (don't await)
    // Use unified buildExecutionContext for all modes
    runService
      .buildExecutionContext({
        checkpointId: body.checkpointId,
        sessionId: body.sessionId,
        agentConfigId: body.agentConfigId,
        conversationId: body.conversationId,
        artifactName: body.artifactName,
        artifactVersion: body.artifactVersion,
        templateVars: body.templateVars,
        volumeVersions: body.volumeVersions,
        prompt: body.prompt,
        runId: run.id,
        sandboxToken,
        userId,
      })
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
