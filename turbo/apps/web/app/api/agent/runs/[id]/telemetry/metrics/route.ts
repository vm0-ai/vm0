import { createNextHandler, tsr } from "@ts-rest/serverless/next";
import { TsRestResponse } from "@ts-rest/serverless";
import { runMetricsContract } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../../../src/db/schema/sandbox-telemetry";
import { eq, gt, and, asc } from "drizzle-orm";
import { getUserId } from "../../../../../../../src/lib/auth/get-user-id";

/**
 * Metric entry structure
 */
interface MetricEntry {
  ts: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

/**
 * Telemetry data structure stored in JSONB
 */
interface TelemetryData {
  metrics?: MetricEntry[];
}

const router = tsr.router(runMetricsContract, {
  getMetrics: async ({ params, query }) => {
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
      .select()
      .from(agentRuns)
      .where(eq(agentRuns.id, params.id))
      .limit(1);

    if (!run || run.userId !== userId) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    const { since, limit } = query;

    // Build query conditions
    const conditions = [eq(sandboxTelemetry.runId, params.id)];
    if (since !== undefined) {
      conditions.push(gt(sandboxTelemetry.createdAt, new Date(since)));
    }

    // Query all telemetry records (we need to extract metrics from them)
    const telemetryRecords = await globalThis.services.db
      .select()
      .from(sandboxTelemetry)
      .where(and(...conditions))
      .orderBy(asc(sandboxTelemetry.createdAt));

    // Collect all metrics entries
    const allMetrics: MetricEntry[] = [];
    for (const record of telemetryRecords) {
      const data = record.data as TelemetryData;
      if (data.metrics) {
        allMetrics.push(...data.metrics);
      }
    }

    // Apply limit to metrics
    const hasMore = allMetrics.length > limit;
    const metrics = hasMore ? allMetrics.slice(0, limit) : allMetrics;

    return {
      status: 200 as const,
      body: {
        metrics,
        hasMore,
      },
    };
  },
});

/**
 * Custom error handler to convert validation errors to API error format
 */
function errorHandler(err: unknown): TsRestResponse | void {
  if (
    err &&
    typeof err === "object" &&
    ("pathParamsError" in err || "queryError" in err)
  ) {
    const validationError = err as {
      pathParamsError: {
        issues: Array<{ path: string[]; message: string }>;
      } | null;
      queryError: {
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

    if (validationError.queryError) {
      const issue = validationError.queryError.issues[0];
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

const handler = createNextHandler(runMetricsContract, router, {
  handlerType: "app-router",
  jsonQuery: true,
  errorHandler,
});

export { handler as GET };
