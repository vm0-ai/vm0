import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../../src/lib/ts-rest-handler";
import { runMetricsContract } from "@vm0/api-contracts/contracts/runs";
import { initServices } from "../../../../../../../src/lib/init-services";
import { agentRuns } from "@vm0/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getAuthContext } from "../../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../../src/lib/zero/org/resolve-org";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
  escapeAplString,
} from "../../../../../../../src/lib/shared/axiom";
interface AxiomMetricEvent {
  _time: string;
  runId: string;
  userId: string;
  cpu: number;
  mem_used: number;
  mem_total: number;
  disk_used: number;
  disk_total: number;
}

const router = tsr.router(runMetricsContract, {
  getMetrics: async ({ params, query, headers }) => {
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

    const { since, limit, order } = query;

    // Build APL query for Axiom
    const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_METRICS);
    const sinceFilter = since
      ? `| where _time > datetime("${new Date(since).toISOString()}")`
      : "";
    const apl = `['${dataset}']
| where runId == "${escapeAplString(params.id)}"
${sinceFilter}
| order by _time ${order}
| limit ${limit + 1}`;

    // Query Axiom for metrics
    const events = await queryAxiom<AxiomMetricEvent>(apl);

    // Check if there are more records
    const hasMore = events.length > limit;
    const records = hasMore ? events.slice(0, limit) : events;

    // Transform to API response format
    const metrics = records.map((e) => {
      return {
        ts: e._time,
        cpu: e.cpu,
        mem_used: e.mem_used,
        mem_total: e.mem_total,
        disk_used: e.disk_used,
        disk_total: e.disk_total,
      };
    });

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

const handler = createHandler(runMetricsContract, router, {
  routeName: "agent.runs.telemetry.metrics",
  errorHandler,
});

export { handler as GET };
