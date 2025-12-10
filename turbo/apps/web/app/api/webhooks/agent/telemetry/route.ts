import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { webhookTelemetryContract } from "@vm0/core";
import { initServices } from "../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../src/db/schema/sandbox-telemetry";
import { eq, and } from "drizzle-orm";
import { getUserId } from "../../../../../src/lib/auth/get-user-id";
import { logger } from "../../../../../src/lib/logger";

const log = logger("webhooks:telemetry");

const router = tsr.router(webhookTelemetryContract, {
  send: async ({ body }) => {
    initServices();

    const userId = await getUserId();
    if (!userId) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }

    // Verify run exists and belongs to user
    const [run] = await globalThis.services.db
      .select({ id: agentRuns.id })
      .from(agentRuns)
      .where(and(eq(agentRuns.id, body.runId), eq(agentRuns.userId, userId)))
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Store telemetry data
    const result = await globalThis.services.db
      .insert(sandboxTelemetry)
      .values({
        runId: body.runId,
        data: {
          systemLog: body.systemLog ?? "",
          metrics: body.metrics ?? [],
        },
      })
      .returning({ id: sandboxTelemetry.id });

    const inserted = result[0];
    if (!inserted) {
      return {
        status: 500 as const,
        body: {
          error: {
            message: "Failed to insert telemetry record",
            code: "INTERNAL_ERROR",
          },
        },
      };
    }

    log.debug(
      `Stored telemetry for run ${body.runId}: systemLog=${body.systemLog?.length ?? 0} bytes, metrics=${body.metrics?.length ?? 0} entries`,
    );

    return {
      status: 200 as const,
      body: {
        success: true,
        id: inserted.id,
      },
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

  log.error("Telemetry error:", err);
  return undefined;
}

const handler = createNextHandler(webhookTelemetryContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as POST };
