import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { webhookComposeCompleteContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { composeJobs } from "../../../../../src/db/schema/compose-job";
import { eq } from "drizzle-orm";
import { verifyComposeJobToken } from "../../../../../src/lib/auth/sandbox-token";
import { logger } from "../../../../../src/lib/logger";
import yaml from "yaml";
import { createComposeFromYaml } from "../../../../../src/lib/compose/compose-service";

const log = logger("webhook:compose-complete");

const router = tsr.router(webhookComposeCompleteContract, {
  complete: async ({ body, headers }) => {
    initServices();

    // Verify JWT token
    const authHeader = headers.authorization;
    if (!authHeader?.startsWith("Bearer ")) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Missing authorization token",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const token = authHeader.slice(7);
    const auth = verifyComposeJobToken(token);
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Invalid or expired token", code: "UNAUTHORIZED" },
        },
      };
    }

    const { jobId, success, yamlContent, result, error } = body;

    // Verify token matches the job ID
    if (auth.jobId !== jobId) {
      log.warn(`Token jobId mismatch: expected ${auth.jobId}, got ${jobId}`);
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Token does not match job ID",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    // Find the job
    const [job] = await globalThis.services.db
      .select()
      .from(composeJobs)
      .where(eq(composeJobs.id, jobId))
      .limit(1);

    if (!job) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Job not found", code: "NOT_FOUND" },
        },
      };
    }

    // Check if job is already completed (idempotency)
    if (job.status === "completed" || job.status === "failed") {
      log.debug(
        `Job ${jobId} already ${job.status}, ignoring duplicate callback`,
      );
      return {
        status: 200 as const,
        body: { success: true },
      };
    }

    // Process the result
    let finalResult = result;
    let finalError = error;

    // If yamlContent is provided and success, parse and create compose
    if (success && yamlContent && !result) {
      try {
        log.debug(`Parsing YAML content for job ${jobId}...`);

        // Parse YAML
        const content = yaml.parse(yamlContent) as Record<string, unknown>;

        // Create compose via service
        const composeResult = await createComposeFromYaml(
          auth.userId,
          content,
          job.overwrite,
        );

        finalResult = {
          composeId: composeResult.composeId,
          composeName: composeResult.composeName,
          versionId: composeResult.versionId,
          warnings: composeResult.warnings || [],
        };

        log.info(
          `Job ${jobId} completed: compose=${finalResult.composeName}, version=${finalResult.versionId}`,
        );
      } catch (err) {
        const errorMessage =
          err instanceof Error ? err.message : "Failed to create compose";
        log.error(`Job ${jobId} failed to create compose: ${errorMessage}`);
        finalError = errorMessage;
        finalResult = undefined;
      }
    }

    // Update job status
    const updateData: {
      status: string;
      completedAt: Date;
      result?: typeof finalResult;
      error?: string;
    } = {
      status: success && finalResult ? "completed" : "failed",
      completedAt: new Date(),
    };

    if (finalResult) {
      updateData.result = finalResult;
    }
    if (finalError) {
      updateData.error = finalError;
      log.error(`Job ${jobId} failed: ${finalError}`);
    }

    await globalThis.services.db
      .update(composeJobs)
      .set(updateData)
      .where(eq(composeJobs.id, jobId));

    return {
      status: 200 as const,
      body: { success: true },
    };
  },
});

/**
 * Custom error handler
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "bodyError" in err) {
    const validationError = err as {
      bodyError: { issues: Array<{ path: string[]; message: string }> } | null;
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

const handler = createHandler(webhookComposeCompleteContract, router, {
  errorHandler,
});

export { handler as POST };
