import {
  runsMainContract,
  runEventsContract,
  runSystemLogContract,
  runMetricsContract,
  runAgentEventsContract,
  runNetworkLogsContract,
} from "@vm0/core";
import {
  getClientConfig,
  createClient,
  handleError,
} from "../core/client-factory";
import type {
  CreateRunResponse,
  GetEventsResponse,
  GetSystemLogResponse,
  GetMetricsResponse,
  GetAgentEventsResponse,
  GetNetworkLogsResponse,
} from "../core/types";

export async function createRun(body: {
  checkpointId?: string;
  sessionId?: string;
  agentComposeId?: string;
  agentComposeVersionId?: string;
  conversationId?: string;
  artifactName?: string;
  artifactVersion?: string;
  vars?: Record<string, string>;
  secrets?: Record<string, string>;
  volumeVersions?: Record<string, string>;
  debugNoMockClaude?: boolean;
  prompt: string;
}): Promise<CreateRunResponse> {
  const config = await getClientConfig();
  const client = createClient(runsMainContract, config);

  const result = await client.create({ body });

  if (result.status === 201) {
    return result.body;
  }

  handleError(result, "Failed to create run");
}

export async function getEvents(
  runId: string,
  options?: { since?: number; limit?: number },
): Promise<GetEventsResponse> {
  const config = await getClientConfig();
  const client = createClient(runEventsContract, config);

  const result = await client.getEvents({
    params: { id: runId },
    query: {
      since: options?.since ?? 0,
      limit: options?.limit ?? 100,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to fetch events");
}

export async function getSystemLog(
  runId: string,
  options?: { since?: number; limit?: number; order?: "asc" | "desc" },
): Promise<GetSystemLogResponse> {
  const config = await getClientConfig();
  const client = createClient(runSystemLogContract, config);

  const result = await client.getSystemLog({
    params: { id: runId },
    query: {
      since: options?.since,
      limit: options?.limit ?? 5,
      order: options?.order ?? "desc",
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
): Promise<GetMetricsResponse> {
  const config = await getClientConfig();
  const client = createClient(runMetricsContract, config);

  const result = await client.getMetrics({
    params: { id: runId },
    query: {
      since: options?.since,
      limit: options?.limit ?? 5,
      order: options?.order ?? "desc",
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
): Promise<GetAgentEventsResponse> {
  const config = await getClientConfig();
  const client = createClient(runAgentEventsContract, config);

  const result = await client.getAgentEvents({
    params: { id: runId },
    query: {
      since: options?.since,
      limit: options?.limit ?? 5,
      order: options?.order ?? "desc",
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
): Promise<GetNetworkLogsResponse> {
  const config = await getClientConfig();
  const client = createClient(runNetworkLogsContract, config);

  const result = await client.getNetworkLogs({
    params: { id: runId },
    query: {
      since: options?.since,
      limit: options?.limit ?? 5,
      order: options?.order ?? "desc",
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to fetch network logs");
}
