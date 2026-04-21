import {
  createHandler,
  tsr,
  TsRestResponse,
} from "../../../../../../../src/lib/ts-rest-handler";
import { runNetworkLogsContract, type AxiomNetworkEvent } from "@vm0/core";
import { initServices } from "../../../../../../../src/lib/init-services";
import { agentRuns } from "../../../../../../../src/db/schema/agent-run";
import { eq, and } from "drizzle-orm";
import { getAuthContext } from "../../../../../../../src/lib/auth/get-auth-context";
import { resolveOrg } from "../../../../../../../src/lib/zero/org/resolve-org";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../../../src/lib/shared/axiom";

const router = tsr.router(runNetworkLogsContract, {
  getNetworkLogs: async ({ params, query, headers }) => {
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

    // Check if there are more records
    const hasMore = events.length > limit;
    const records = hasMore ? events.slice(0, limit) : events;

    const networkLogs = records.map((e) => {
      // [NETWORK_LOG_FIELDS] — keep in sync with all network log schemas
      return {
        timestamp: e._time,
        type: e.type,
        action: e.action,
        host: e.host,
        port: e.port,
        method: e.method,
        url: e.url,
        status: e.status,
        latency_ms: e.latency_ms,
        request_size: e.request_size,
        response_size: e.response_size,
        firewall_base: e.firewall_base,
        firewall_name: e.firewall_name,
        firewall_permission: e.firewall_permission,
        firewall_rule_match: e.firewall_rule_match,
        firewall_params: e.firewall_params,
        firewall_billable: e.firewall_billable,
        firewall_error: e.firewall_error,
        auth_resolved_secrets: e.auth_resolved_secrets,
        auth_refreshed_connectors: e.auth_refreshed_connectors,
        auth_refreshed_secrets: e.auth_refreshed_secrets,
        auth_cache_hit: e.auth_cache_hit,
        auth_url_rewrite: e.auth_url_rewrite,
        error: e.error,
        // Capture-only fields (opt-in via captureNetworkBodies)
        request_headers: e.request_headers,
        request_body: e.request_body,
        request_body_encoding: e.request_body_encoding,
        request_body_truncated: e.request_body_truncated,
        response_headers: e.response_headers,
        response_body: e.response_body,
        response_body_encoding: e.response_body_encoding,
        response_body_truncated: e.response_body_truncated,
      };
    });

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
  routeName: "agent.runs.telemetry.network",
  errorHandler,
});

export { handler as GET };
