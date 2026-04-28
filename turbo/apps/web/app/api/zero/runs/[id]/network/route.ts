import { createHandler, tsr } from "../../../../../../src/lib/ts-rest-handler";
import { zeroRunNetworkLogsContract } from "@vm0/api-contracts/contracts/zero-runs";
import type { AxiomNetworkEvent } from "@vm0/api-contracts/contracts/runs";
import { initServices } from "../../../../../../src/lib/init-services";
import {
  requireAuth,
  isAuthError,
} from "../../../../../../src/lib/auth/require-auth";
import { resolveOrg } from "../../../../../../src/lib/zero/org/resolve-org";
import { getRunById } from "../../../../../../src/lib/infra/run/run-service";
import {
  queryAxiom,
  getDatasetName,
  DATASETS,
} from "../../../../../../src/lib/shared/axiom";

const router = tsr.router(zeroRunNetworkLogsContract, {
  getNetworkLogs: async ({ params, query, headers }) => {
    initServices();

    const authCtx = await requireAuth(headers.authorization, {
      requiredCapability: "agent-run:read",
    });
    if (isAuthError(authCtx)) return authCtx;
    const { userId } = authCtx;

    const { org } = await resolveOrg(authCtx);

    const run = await getRunById(params.id, userId, org.orgId);
    if (!run) {
      return {
        status: 404 as const,
        body: {
          error: { message: "Agent run not found", code: "NOT_FOUND" },
        },
      };
    }

    const { since, limit, order } = query;

    const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
    const sinceFilter = since
      ? `| where _time > datetime("${new Date(since).toISOString()}")`
      : "";
    const apl = `['${dataset}']
| where runId == "${params.id}"
${sinceFilter}
| order by _time ${order}
| limit ${limit + 1}`;

    const events = await queryAxiom<AxiomNetworkEvent>(apl);

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
        dns_event: e.dns_event,
        dns_query_type: e.dns_query_type,
        dns_result: e.dns_result,
        dns_serial: e.dns_serial,
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

const handler = createHandler(zeroRunNetworkLogsContract, router, {
  routeName: "zero.runs.network",
});

export { handler as GET };
