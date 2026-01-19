import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../../src/lib/ts-rest-handler";
import { runNetworkLogsContract } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { eq } from "drizzle-orm";
import { getUserId } from "../../../../../../../src/lib/auth/get-user-id";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../../../src/lib/axiom";

/**
 * Axiom network event supports two modes:
 * - sni: SNI-only mode (no HTTPS decryption, only host/port/action)
 * - mitm: MITM mode (full HTTP details including method, status, latency, sizes)
 */
interface AxiomNetworkEvent {
  _time: string;
  runId: string;
  userId: string;
  // Common fields (all modes)
  mode?: "mitm" | "sni";
  action?: "ALLOW" | "DENY";
  host?: string;
  port?: number;
  rule_matched?: string | null;
  // MITM-only fields (optional)
  method?: string;
  url?: string;
  status?: number;
  latency_ms?: number;
  request_size?: number;
  response_size?: number;
}

const router = tsr.router(runNetworkLogsContract, {
  getNetworkLogs: async ({ params, query }) => {
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

    const { since, limit, order } = query;

    // Build APL query for Axiom
    const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
    const sinceFilter = since
      ? `| where _time > datetime("${new Date(since).toISOString()}")`
      : "";
    const apl = `['${dataset}']
| where runId == "${params.id}"
${sinceFilter}
| order by _time ${order}
| limit ${limit + 1}`;

    // Query Axiom for network logs
    const events = await queryAxiom<AxiomNetworkEvent>(apl);

    // If Axiom is not configured or query failed, return empty
    if (events === null) {
      return {
        status: 200 as const,
        body: {
          networkLogs: [],
          hasMore: false,
        },
      };
    }

    // Check if there are more records
    const hasMore = events.length > limit;
    const records = hasMore ? events.slice(0, limit) : events;

    // Transform to API response format (supports both SNI-only and MITM modes)
    const networkLogs = records.map((e) => ({
      timestamp: e._time,
      // Common fields (all modes)
      mode: e.mode,
      action: e.action,
      host: e.host,
      port: e.port,
      rule_matched: e.rule_matched,
      // MITM-only fields (may be undefined for SNI-only mode)
      method: e.method,
      url: e.url,
      status: e.status,
      latency_ms: e.latency_ms,
      request_size: e.request_size,
      response_size: e.response_size,
    }));

    return {
      status: 200 as const,
      body: {
        networkLogs,
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

const handler = createHandler(runNetworkLogsContract, router, {
  errorHandler,
});

export { handler as GET };
