import { createHandler, tsr } from "../../../../../src/lib/ts-rest-handler";
import { runsByIdContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
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

    // Query run from database - filter by userId for security
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(and(eq(agentRuns.id, params.id), eq(agentRuns.userId, userId)))
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

const handler = createHandler(runsByIdContract, router);

export { handler as GET };
