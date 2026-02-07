import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { composeJobsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { composeJobs } from "../../../../../src/db/schema/compose-job";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import type { ComposeJobResult } from "../../../../../src/db/schema/compose-job";

/**
 * Format job record for API response
 */
function formatJobResponse(job: {
  id: string;
  status: string;
  githubUrl: string;
  result: ComposeJobResult | null;
  error: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
}) {
  return {
    jobId: job.id,
    status: job.status as "pending" | "running" | "completed" | "failed",
    githubUrl: job.githubUrl,
    result: job.result ?? undefined,
    error: job.error ?? undefined,
    createdAt: job.createdAt.toISOString(),
    startedAt: job.startedAt?.toISOString(),
    completedAt: job.completedAt?.toISOString(),
  };
}

const router = tsr.router(composeJobsByIdContract, {
  getById: async ({ params, headers }) => {
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

    const { jobId } = params;

    // Find job belonging to this user
    const [job] = await globalThis.services.db
      .select()
      .from(composeJobs)
      .where(and(eq(composeJobs.id, jobId), eq(composeJobs.userId, userId)))
      .limit(1);

    if (!job) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Job not found", code: "NOT_FOUND" },
        },
      };
    }

    return {
      status: 200 as const,
      body: formatJobResponse(job),
    };
  },
});

/**
 * Custom error handler
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (err && typeof err === "object" && "pathParamsError" in err) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
    };

    if (validationError.pathParamsError) {
      const issue = validationError.pathParamsError.issues[0];
      if (issue) {
        return TsRestResponse.fromJson(
          { error: { message: "Invalid job ID format", code: "BAD_REQUEST" } },
          { status: 400 },
        );
      }
    }
  }

  return undefined;
}

const handler = createHandler(composeJobsByIdContract, router, {
  errorHandler,
});

export { handler as GET };
