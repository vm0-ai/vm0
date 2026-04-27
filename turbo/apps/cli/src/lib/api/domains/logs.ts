import { initClient } from "@ts-rest/core";
import {
  runSystemLogContract,
  runMetricsContract,
  runAgentEventsContract,
  runNetworkLogsContract,
  logsSearchContract,
  type AgentEventsResponse,
  type LogsSearchResponse,
  type MetricsResponse,
  type NetworkLogsResponse,
  type SystemLogResponse,
} from "@vm0/api-contracts/contracts/runs";
import { getClientConfig, handleError } from "../core/client-factory";

// Re-export types used by consumer commands (logs/index.ts, logs/search.ts)
export type {
  RunEvent,
  TelemetryMetric,
  NetworkLogEntry,
  LogsSearchResponse,
} from "@vm0/api-contracts/contracts/runs";

export async function getSystemLog(
  runId: string,
  options?: { since?: number; limit?: number; order?: "asc" | "desc" },
): Promise<SystemLogResponse> {
  const config = await getClientConfig();
  const client = initClient(runSystemLogContract, config);

  const result = await client.getSystemLog({
    params: { id: runId },
    query: {
      since: options?.since,
      limit: options?.limit,
      order: options?.order,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to fetch system log");
}

export async function getMetrics(
  runId: string,
  options?: { since?: number; limit?: number; order?: "asc" | "desc" },
): Promise<MetricsResponse> {
  const config = await getClientConfig();
  const client = initClient(runMetricsContract, config);

  const result = await client.getMetrics({
    params: { id: runId },
    query: {
      since: options?.since,
      limit: options?.limit,
      order: options?.order,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to fetch metrics");
}

export async function getAgentEvents(
  runId: string,
  options?: { since?: number; limit?: number; order?: "asc" | "desc" },
): Promise<AgentEventsResponse> {
  const config = await getClientConfig();
  const client = initClient(runAgentEventsContract, config);

  const result = await client.getAgentEvents({
    params: { id: runId },
    query: {
      since: options?.since,
      limit: options?.limit,
      order: options?.order,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to fetch agent events");
}

export async function getNetworkLogs(
  runId: string,
  options?: { since?: number; limit?: number; order?: "asc" | "desc" },
): Promise<NetworkLogsResponse> {
  const config = await getClientConfig();
  const client = initClient(runNetworkLogsContract, config);

  const result = await client.getNetworkLogs({
    params: { id: runId },
    query: {
      since: options?.since,
      limit: options?.limit,
      order: options?.order,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to fetch network logs");
}

export async function searchLogs(options: {
  keyword: string;
  agent?: string;
  runId?: string;
  since?: number;
  limit?: number;
  before?: number;
  after?: number;
}): Promise<LogsSearchResponse> {
  const config = await getClientConfig();
  const client = initClient(logsSearchContract, config);

  const result = await client.searchLogs({
    query: {
      keyword: options.keyword,
      agent: options.agent,
      runId: options.runId,
      since: options.since,
      limit: options.limit,
      before: options.before,
      after: options.after,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to search logs");
}
