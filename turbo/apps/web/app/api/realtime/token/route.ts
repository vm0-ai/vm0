import { createHandler, tsr } from "../../../../src/lib/ts-rest-handler";
import { realtimeTokenContract } from "@vm0/core";
import { initServices } from "../../../../src/lib/init-services";
import { agentRuns } from "../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../src/lib/auth/get-user-id";
import { generateRunToken } from "../../../../src/lib/realtime/client";

const router = tsr.router(realtimeTokenContract, {
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

    const { runId } = body;

    // Query run from database to verify ownership
    const [run] = await globalThis.services.db
      .select({ userId: agentRuns.userId })
      .from(agentRuns)
      .where(eq(agentRuns.id, runId))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Verify user owns this run
    if (run.userId !== userId) {
      return {
        status: 403 as const,
        body: {
          error: {
            message: "You do not have access to this run",
            code: "FORBIDDEN",
          },
        },
      };
    }

    // Generate Ably token for this run's channel
    const tokenRequest = await generateRunToken(runId);

    if (!tokenRequest) {
      return {
        status: 500 as const,
        body: {
          error: {
            message: "Realtime service unavailable",
            code: "INTERNAL_SERVER_ERROR",
          },
        },
      };
    }

    return {
      status: 200 as const,
      body: tokenRequest,
    };
  },
});

const handler = createHandler(realtimeTokenContract, router);

export { handler as POST };
