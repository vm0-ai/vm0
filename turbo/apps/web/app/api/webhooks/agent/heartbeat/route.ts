import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { webhookHeartbeatContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getSandboxAuthForRun } from "../../../../../src/lib/auth/get-sandbox-auth";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhooks:heartbeat");

const router = tsr.router(webhookHeartbeatContract, {
  send: async ({ body }) => {
    initServices();

    // Authenticate with sandbox JWT and verify runId matches
    const auth = await getSandboxAuthForRun(body.runId);
    if (!auth) {
      return {
        status: 401 as const,
        body: {
          error: {
            message: "Not authenticated or runId mismatch",
            code: "UNAUTHORIZED",
          },
        },
      };
    }

    const { userId } = auth;

    const result = await globalThis.services.db
      .update(agentRuns)
      .set({ lastHeartbeatAt: new Date() })
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .returning({ id: agentRuns.id });

    if (result.length === 0) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    log.debug(`Updated heartbeat for run ${body.runId}`);

    return {
      status: 200 as const,
      body: { ok: true },
    };
  },
});

/**
 * Custom error handler to convert Zod validation errors to API error format
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

const handler = createNextHandler(webhookHeartbeatContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as POST };
