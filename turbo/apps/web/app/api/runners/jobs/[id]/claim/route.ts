import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { runnersJobClaimContract, createErrorResponse } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { runners } from "../../../../../../src/db/schema/runner";
import { agentComposeVersions } from "../../../../../../src/db/schema/agent-compose";
import { eq, and, isNull } from "drizzle-orm";
import { getUserId } from "../../../../../../src/lib/auth/get-user-id";
import { generateSandboxToken } from "../../../../../../src/lib/auth/sandbox-token";
import { logger } from "../../../../../../src/lib/logger";
import { storageService } from "../../../../../../src/lib/storage/storage-service";
import type { AgentComposeYaml } from "../../../../../../src/types/agent-compose";

const log = logger("api:runners:jobs:claim");

// Force dynamic rendering to prevent any caching
export const dynamic = "force-dynamic";

/**
 * Get the first agent from compose (currently only one agent is supported)
 */
function getFirstAgent(
  compose?: AgentComposeYaml,
): AgentComposeYaml["agents"][string] | undefined {
  if (!compose?.agents) return undefined;
  const values = Object.values(compose.agents);
  return values[0];
}

const router = tsr.router(runnersJobClaimContract, {
  claim: async ({ params, body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return createErrorResponse("UNAUTHORIZED", "Not authenticated");
    }

    const { id: runId } = params;
    const { runnerId } = body;

    log.debug(`Runner ${runnerId} claiming job: ${runId}`);

    // Verify the runner exists and belongs to the user
    const [runner] = await globalThis.services.db
      .select()
      .from(runners)
      .where(and(eq(runners.id, runnerId), eq(runners.userId, userId)))
      .limit(1);

    if (!runner) {
      return createErrorResponse("NOT_FOUND", "Runner not found");
    }

    // Fetch the pending run
    const [pendingRun] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.status, "pending"),
          isNull(agentRuns.runnerId),
        ),
      )
      .limit(1);

    if (!pendingRun) {
      // Check if job exists but is already claimed
      const [existingRun] = await globalThis.services.db
        .select()
        .from(agentRuns)
        .where(eq(agentRuns.id, runId))
        .limit(1);

      if (existingRun) {
        if (existingRun.runnerId) {
          return createErrorResponse("CONFLICT", "Job already claimed");
        }
        return createErrorResponse(
          "CONFLICT",
          `Job is not available (status: ${existingRun.status})`,
        );
      }

      return createErrorResponse("NOT_FOUND", "Job not found");
    }

    // Claim the job - atomically update status and set runner
    const now = new Date();
    const [claimedRun] = await globalThis.services.db
      .update(agentRuns)
      .set({
        runnerId,
        claimedAt: now,
        status: "running",
        startedAt: now,
        lastHeartbeatAt: now,
      })
      .where(
        and(
          eq(agentRuns.id, runId),
          eq(agentRuns.status, "pending"),
          isNull(agentRuns.runnerId),
        ),
      )
      .returning();

    if (!claimedRun) {
      // Race condition - job was claimed by another runner
      return createErrorResponse(
        "CONFLICT",
        "Job was claimed by another runner",
      );
    }

    log.debug(`Job ${runId} claimed by runner ${runnerId}`);

    // Generate sandbox token for the runner to use when calling webhooks
    const sandboxToken = await generateSandboxToken(
      pendingRun.userId,
      pendingRun.id,
    );

    // Get agent compose version for working_dir and provider
    const [composeVersion] = await globalThis.services.db
      .select()
      .from(agentComposeVersions)
      .where(eq(agentComposeVersions.id, claimedRun.agentComposeVersionId))
      .limit(1);

    const agentCompose = composeVersion?.content as
      | AgentComposeYaml
      | undefined;
    const firstAgent = getFirstAgent(agentCompose);
    const workingDir = firstAgent?.working_dir || "/workspace";
    const cliAgentType = firstAgent?.provider || "claude-code";

    log.debug(`Working dir: ${workingDir}, CLI type: ${cliAgentType}`);

    // Prepare storage manifest with presigned URLs
    // Note: artifactName, artifactVersion, volumeVersions are not stored in agentRuns
    // For now, we prepare manifest without artifact (runner jobs don't support artifact yet)
    let storageManifest = null;
    try {
      storageManifest = await storageService.prepareStorageManifest(
        agentCompose,
        (claimedRun.vars as Record<string, string>) || {},
        claimedRun.userId,
        undefined, // artifactName - not available in agentRuns
        undefined, // artifactVersion - not available in agentRuns
        undefined, // volumeVersions - not available in agentRuns
        undefined, // resumeArtifact handled separately
        workingDir,
      );
      log.debug(
        `Storage manifest prepared with ${storageManifest.storages.length} storages`,
      );
    } catch (err) {
      log.warn(
        `Failed to prepare storage manifest: ${err instanceof Error ? err.message : err}`,
      );
    }

    // Get resume session if checkpointId present
    // Note: checkpoints table uses different schema - it stores agentComposeSnapshot, not sessionHistory
    // For now, resumeSession is not supported for runner jobs
    const resumeSession = null;
    if (claimedRun.resumedFromCheckpointId) {
      log.debug(
        `Resume from checkpoint ${claimedRun.resumedFromCheckpointId} requested but not yet implemented for runners`,
      );
      // TODO: Implement resume session support for runners
      // This requires storing session history in checkpoints or agent_sessions table
    }

    // Expand environment variables from agent compose
    let environment: Record<string, string> | null = null;
    if (firstAgent?.environment) {
      environment = {};
      for (const [key, value] of Object.entries(firstAgent.environment)) {
        // Expand ${{ vars.X }} references
        if (typeof value === "string") {
          environment[key] = value.replace(
            /\$\{\{\s*vars\.(\w+)\s*\}\}/g,
            (_, varName) => {
              const vars = claimedRun.vars as Record<string, string> | null;
              return vars?.[varName] || "";
            },
          );
        }
      }
    }

    // Note: secretValues are not available in runner context
    // Secrets need to be resolved separately by the runner if needed
    // For now, we pass null and the runner can implement secret resolution later
    const secretValues: string[] | null = null;

    // Return execution context
    return {
      status: 200 as const,
      body: {
        runId: claimedRun.id,
        prompt: claimedRun.prompt,
        agentComposeVersionId: claimedRun.agentComposeVersionId,
        vars: (claimedRun.vars as Record<string, string>) ?? null,
        secretNames: claimedRun.secretNames ?? null,
        checkpointId: claimedRun.resumedFromCheckpointId ?? null,
        sandboxToken,
        apiUrl: globalThis.services.env.VM0_API_URL || "https://www.vm0.ai",
        // New fields for E2B parity:
        workingDir,
        storageManifest,
        environment,
        resumeSession,
        secretValues,
        cliAgentType,
      },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    "bodyError" in err &&
    "queryError" in err
  ) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
      queryError: { issues: Array<{ path: string[]; message: string }> } | null;
    };

    if (validationError.bodyError) {
      const issue = validationError.bodyError.issues[0];
      if (issue) {
        const path = issue.path.join(".");
        const message = path ? `${path}: ${issue.message}` : issue.message;
        return TsRestResponse.fromJson(
          { error: { message, code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(runnersJobClaimContract, router, {
  errorHandler,
});

export { handler as POST };
