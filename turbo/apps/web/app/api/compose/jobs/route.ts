import crypto from "crypto";
import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../src/lib/ts-rest-handler";
import { composeJobsMainContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { composeJobs } from "../../../../src/db/schema/compose-job";
import { eq, and, inArray } from "drizzle-orm";
import { getAuthContext } from "../../../../src/lib/auth/get-user-id";
import { resolveOrg } from "../../../../src/lib/org/resolve-org";
import { logger } from "../../../../src/lib/logger";
import { triggerComposeJob } from "../../../../src/lib/compose/trigger-compose-job";
import { serverSideCompose } from "../../../../src/lib/compose/server-side-compose";
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
  create: async ({ body, headers }, { request }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization);
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    // Resolve the caller's org
    const orgSlug = new URL(request.url).searchParams.get("org");
    const { org } = await resolveOrg(authCtx, orgSlug);

    // Dispatch based on input type: GitHub URL or platform content
    const isGitHubInput = "githubUrl" in body;

    // Try server-side compose for platform mode (bypasses E2B sandbox)
    if (!isGitHubInput) {
      // Check for existing active job first (preserve idempotency)
      const [existingActiveJob] = await globalThis.services.db
        .select()
        .from(composeJobs)
        .where(
          and(
            eq(composeJobs.userId, userId),
            inArray(composeJobs.status, ["pending", "running"]),
          ),
        )
        .limit(1);

      if (existingActiveJob) {
        log.debug(
          `Returning existing active job ${existingActiveJob.id} for user ${userId}`,
        );
        return {
          status: 200 as const,
          body: formatJobResponse(existingActiveJob),
        };
      }

      // Attempt server-side compose — returns null if fallback needed
      const serverResult = await serverSideCompose({
        userId,
        orgId: org.orgId,
        orgSlug: org.slug,
        content: body.content,
        instructions: body.instructions,
      });

      if (serverResult) {
        // Server-side compose succeeded — create completed job record
        const jobId = crypto.randomUUID();
        const now = new Date();
        const jobResult: ComposeJobResult = {
          composeId: serverResult.composeId,
          composeName: serverResult.composeName,
          versionId: serverResult.versionId,
          warnings: [],
        };

        await globalThis.services.db.insert(composeJobs).values({
          id: jobId,
          userId,
          source: "platform",
          status: "completed",
          content: body.content,
          instructions: body.instructions,
          result: jobResult,
          createdAt: now,
          completedAt: now,
        });

        log.info(
          `Server-side compose completed for user ${userId}: ${serverResult.composeName}`,
        );

        return {
          status: 201 as const,
          body: formatJobResponse({
            id: jobId,
            status: "completed",
            githubUrl: null,
            source: "platform",
            result: jobResult,
            createdAt: now,
            completedAt: now,
          }),
        };
      }

      // Server-side compose not possible — fall back to sandbox
      log.info(
        `Server-side compose not possible for user ${userId}, falling back to sandbox`,
      );
    }

    // GitHub mode or server-side fallback: use sandbox
    const result = isGitHubInput
      ? await triggerComposeJob({
          userId,
          orgSlug: org.slug,
          source: "github",
          githubUrl: body.githubUrl,
          overwrite: body.overwrite,
        })
      : await triggerComposeJob({
          userId,
          orgSlug: org.slug,
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
