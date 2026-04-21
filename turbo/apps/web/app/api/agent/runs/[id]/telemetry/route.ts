import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../src/lib/ts-rest-handler";
import { runTelemetryContract } from "@vm0/core";
import { initServices } from "../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../src/db/schema/agent-run";
import { sandboxTelemetry } from "../../../../../../src/db/schema/sandbox-telemetry";
import { eq, and } from "drizzle-orm";
import { getAuthContext } from "../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";

/**
 * Telemetry data structure stored in JSONB
 */
interface TelemetryData {
  systemLog?: string;
  metrics?: Array<{
    ts: string;
    cpu: number;
    mem_used: number;
    mem_total: number;
    disk_used: number;
    disk_total: number;
  }>;
}

const router = tsr.router(runTelemetryContract, {
  getTelemetry: async ({ params, headers }) => {
    initServices();

    const authCtx = await getAuthContext(headers.authorization, {
      acceptAnySandboxCapability: true,
    });
    if (!authCtx) {
      return {
        status: 401 as const,
        body: {
          error: { message: "Not authenticated", code: "UNAUTHORIZED" },
        },
      };
    }
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    // Verify run exists and belongs to user+org
    const [run] = await globalThis.services.db
      .select()
      .from(agentRuns)
      .where(
        and(
          eq(agentRuns.id, params.id),
          eq(agentRuns.userId, userId),
          eq(agentRuns.orgId, org.orgId),
        ),
      )
      .limit(1);

    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    // Query all telemetry records for this run and aggregate
    const telemetryRecords = await globalThis.services.db
      .select()
      .from(sandboxTelemetry)
      .where(eq(sandboxTelemetry.runId, params.id))
      .orderBy(sandboxTelemetry.createdAt);

    // Aggregate system logs and metrics from all records
    let aggregatedSystemLog = "";
    const aggregatedMetrics: TelemetryData["metrics"] = [];

    for (const record of telemetryRecords) {
      const data = record.data as TelemetryData;
      if (data.systemLog) {
        aggregatedSystemLog += data.systemLog;
      }
      if (data.metrics) {
        aggregatedMetrics.push(...data.metrics);
      }
    }

    return {
      status: 200 as const,
      body: {
        systemLog: aggregatedSystemLog,
        metrics: aggregatedMetrics,
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

const handler = createHandler(runTelemetryContract, router, {
  routeName: "agent.runs.telemetry",
  errorHandler,
});

export { handler as GET };
