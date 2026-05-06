import type { AxiomNetworkEvent } from "@vm0/api-contracts/contracts/runs";
import { queryAxiom, getDatasetName, DATASETS } from "../../shared/axiom";
import { queryRunContext } from "./run-context-service";
import { logger } from "../../shared/logger";

const log = logger("service:activity-log");

interface AxiomAgentEvent {
  _time: string;
  runId: string;
  sequenceNumber: number;
  eventType: string;
  eventData: Record<string, unknown>;
}

export interface RunMeta {
  id: string;
  status: string;
  error: string | null;
  prompt: string;
  appendSystemPrompt: string | null;
  createdAt: Date;
  startedAt: Date | null;
  completedAt: Date | null;
  runnerGroup: string | null;
  continuedFromSessionId: string | null;
  result: unknown;
}

interface AgentMeta {
  displayName?: string | null;
  composeContent?: unknown;
}

/**
 * Assemble an activity log JSON matching the format downloaded from the
 * activity detail page (meta + events + context + networkLogs).
 *
 * Fetches agent telemetry events, network logs, and run context from Axiom,
 * then assembles them into a single JSON object.
 */
export async function assembleActivityLog(
  runId: string,
  run: RunMeta,
  agent: AgentMeta,
): Promise<Record<string, unknown>> {
  const [events, networkLogs, runContext] = await Promise.all([
    queryAgentEvents(runId),
    queryNetworkLogs(runId),
    queryRunContext(runId).catch((err) => {
      log.warn("Failed to collect run context", { error: String(err) });
      return null;
    }),
  ]);

  const data: Record<string, unknown> = {
    meta: buildMeta(run, agent),
    events: events.map((e) => {
      return {
        sequenceNumber: e.sequenceNumber,
        eventType: e.eventType,
        eventData: e.eventData,
        createdAt: e._time,
      };
    }),
  };

  if (runContext) {
    data.context = runContext;
  }
  if (networkLogs.length > 0) {
    data.networkLogs = mapNetworkLogs(networkLogs);
  }

  return data;
}

function buildMeta(run: RunMeta, agent: AgentMeta): Record<string, unknown> {
  const compose = agent.composeContent as {
    agent?: {
      framework?: string;
      modelProvider?: string;
      selectedModel?: string;
    };
  } | null;
  const agentConf = compose?.agent;
  const resultObj = run.result as { agentSessionId?: string } | null;
  const sessionId =
    resultObj?.agentSessionId ?? run.continuedFromSessionId ?? null;

  return {
    id: run.id,
    displayName: agent.displayName ?? null,
    status: run.status,
    modelProvider: agentConf?.modelProvider ?? null,
    selectedModel: agentConf?.selectedModel ?? null,
    framework: agentConf?.framework ?? null,
    prompt: run.prompt,
    appendSystemPrompt: run.appendSystemPrompt,
    error: run.error,
    createdAt: run.createdAt.toISOString(),
    startedAt: run.startedAt?.toISOString() ?? null,
    completedAt: run.completedAt?.toISOString() ?? null,
    sessionId,
    runnerGroup: run.runnerGroup,
  };
}

function mapNetworkLogs(logs: AxiomNetworkEvent[]): Record<string, unknown>[] {
  return logs.map((e) => {
    // [NETWORK_LOG_FIELDS] — mirror NetworkLogEntry for activity downloads,
    // excluding Axiom-only runId/userId and converting _time to timestamp.
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
}

async function queryAgentEvents(runId: string): Promise<AxiomAgentEvent[]> {
  const dataset = getDatasetName(DATASETS.AGENT_RUN_EVENTS);
  const apl = `['${dataset}']
| where runId == "${runId}"
| order by _time asc, sequenceNumber asc
| limit 5000`;
  return queryAxiom<AxiomAgentEvent>(apl).catch((err) => {
    log.warn("Failed to collect agent telemetry", { error: String(err) });
    return [];
  });
}

async function queryNetworkLogs(runId: string): Promise<AxiomNetworkEvent[]> {
  const dataset = getDatasetName(DATASETS.SANDBOX_TELEMETRY_NETWORK);
  const apl = `['${dataset}']
| where runId == "${runId}"
| order by _time asc
| limit 5000`;
  return queryAxiom<AxiomNetworkEvent>(apl).catch((err) => {
    log.warn("Failed to collect network logs", { error: String(err) });
    return [];
  });
}
