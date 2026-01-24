import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../src/lib/ts-rest-handler";
import { runsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";

const router = tsr.router(runsByIdContract, {
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

    // Query run from database
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    return {
      status: 200 as const,
      body: {
        runId: run.id,
        agentComposeVersionId: run.agentComposeVersionId,
        status: run.status as
          | "pending"
          | "running"
          | "completed"
          | "failed"
          | "timeout",
        prompt: run.prompt,
        vars: run.vars as Record<string, string> | undefined,
        sandboxId: run.sandboxId || undefined,
        result: run.result as
          | { output: string; executionTimeMs: number }
          | undefined,
        error: run.error || undefined,
        createdAt: run.createdAt.toISOString(),
        startedAt: run.startedAt?.toISOString(),
        completedAt: run.completedAt?.toISOString(),
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
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

const handler = createHandler(runsByIdContract, router, {
  errorHandler,
});

export { handler as GET };
