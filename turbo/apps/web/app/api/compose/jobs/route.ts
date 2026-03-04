import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { composeJobsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { composeJobs } from "../../../../src/db/schema/compose-job";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../src/lib/logger";
import { triggerComposeJob } from "../../../../src/lib/compose/trigger-compose-job";
import type { ComposeJobResult } from "../../../../src/db/schema/compose-job";

const log = logger("api:compose-jobs");

/**
 * Format job record for API response
 */
function formatJobResponse(job: {
  id: string;
  status: string;
  githubUrl: string | null;
  source?: string | null;
  result?: ComposeJobResult | null;
  error?: string | null;
  createdAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
}) {
  return {
    jobId: job.id,
    status: job.status as "pending" | "running" | "completed" | "failed",
    githubUrl: job.githubUrl ?? undefined,
    source: (job.source as "github" | "platform" | "slack") ?? undefined,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString(),
    completedAt: job.completedAt?.toISOString(),
  };
}

const router = tsr.router(composeJobsMainContract, {
  create: async ({ body, headers }) => {
    initServices();

    const userId = await getUserId(headers.authorization);
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Dispatch based on input type: GitHub URL or platform content
    const isGitHubInput = "githubUrl" in body;

    const result = isGitHubInput
      ? await triggerComposeJob({
          userId,
          source: "github",
          githubUrl: body.githubUrl,
          overwrite: body.overwrite,
        })
      : await triggerComposeJob({
          userId,
          source: "platform",
          content: body.content,
          instructions: body.instructions,
        });

    if (result.isExisting) {
      // Fetch the full job record for the existing job response (may have result/error)
      const [job] = await globalThis.services.db
        .select()
        .from(composeJobs)
        .where(eq(composeJobs.id, result.jobId))
        .limit(1);

      log.debug(`Returning existing job ${result.jobId} for user ${userId}`);
      return {
        status: 200 as const,
        body: formatJobResponse(job!),
      };
    }

    // For new jobs, use the data from triggerComposeJob directly
    // (avoids race condition where sandbox may have already updated status)
    return {
      status: 201 as const,
      body: formatJobResponse({
        id: result.jobId,
        status: result.status,
        githubUrl: result.githubUrl ?? null,
        source: result.source,
        createdAt: result.createdAt,
      }),
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

const handler = createHandler(composeJobsMainContract, router, {
  errorHandler,
});

export { handler as POST };
