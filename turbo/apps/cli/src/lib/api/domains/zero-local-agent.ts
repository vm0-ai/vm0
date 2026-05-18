import { initClient } from "@ts-rest/core";
import type {
  LocalAgentBackend,
  LocalAgentHostJobNextResponse,
  LocalAgentHostListResponse,
  LocalAgentHostStartResponse,
  LocalAgentRealtimeSubscription,
  LocalAgentRunCreateResponse,
  LocalAgentRunListResponse,
  LocalAgentJobStatus,
  LocalAgentRunResponse,
} from "@vm0/api-contracts/contracts/zero-local-agent";
import {
  zeroLocalAgentHostJobsContract,
  zeroLocalAgentHostRealtimeContract,
  zeroLocalAgentHostsContract,
  zeroLocalAgentHeartbeatContract,
  zeroLocalAgentRunContract,
} from "@vm0/api-contracts/contracts/zero-local-agent";
import {
  ApiRequestError,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";

function normalizeConfiguredUrl(value: string): string {
  return value.startsWith("http") ? value : `https://${value}`;
}

function resolveLocalAgentApiBaseUrl(baseUrl: string): string {
  const override = process.env.VM0_API_BACKEND_URL;
  if (override) {
    return normalizeConfiguredUrl(override).replace(/\/$/, "");
  }

  const url = new URL(baseUrl);
  if (url.hostname === "www.vm0.ai" || url.hostname === "app.vm0.ai") {
    url.hostname = "api.vm0.ai";
  }
  return url.toString().replace(/\/$/, "");
}

function buildHeaders(token?: string): Record<string, string> {
  const headers: Record<string, string> = {};
  if (token) {
    headers.Authorization = `Bearer ${token}`;
  }
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  return headers;
}

async function getLocalAgentClientConfig() {
  const baseUrl = resolveLocalAgentApiBaseUrl(await getBaseUrl());
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  return {
    baseUrl,
    baseHeaders: buildBearerHeaders(token),
    jsonQuery: false as const,
  };
}

function buildBearerHeaders(token: string): Record<string, string> {
  return buildHeaders(token);
}

export async function sendLocalAgentHeartbeat(params: {
  hostToken: string;
  hostName: string;
  supportedBackends: LocalAgentBackend[];
}): Promise<{ hostId: string }> {
  const baseUrl = resolveLocalAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroLocalAgentHeartbeatContract, {
    baseUrl,
    baseHeaders: buildBearerHeaders(params.hostToken),
    jsonQuery: false as const,
  });

  const result = await client.heartbeat({
    body: {
      hostName: params.hostName,
      supportedBackends: params.supportedBackends,
    },
  });

  if (result.status === 200) {
    return { hostId: result.body.hostId };
  }

  handleError(result, "Failed to send local-agent heartbeat");
}

export async function createLocalAgentHostRealtimeSubscription(params: {
  hostToken: string;
}): Promise<LocalAgentRealtimeSubscription> {
  const baseUrl = resolveLocalAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroLocalAgentHostRealtimeContract, {
    baseUrl,
    baseHeaders: buildBearerHeaders(params.hostToken),
    jsonQuery: false as const,
  });

  const result = await client.create({ body: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create local-agent realtime subscription");
}

export async function createLocalAgentRun(params: {
  prompt: string;
  hostName?: string;
}): Promise<LocalAgentRunCreateResponse> {
  const config = await getLocalAgentClientConfig();
  const client = initClient(zeroLocalAgentRunContract, config);

  const result = await client.create({ body: params });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create local-agent run");
}

export async function startLocalAgentHost(params: {
  hostName: string;
  supportedBackends: LocalAgentBackend[];
  hostId?: string;
}): Promise<LocalAgentHostStartResponse> {
  const config = await getLocalAgentClientConfig();
  const client = initClient(zeroLocalAgentHostsContract, config);

  const result = await client.start({ body: params });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to start local-agent host");
}

export async function listLocalAgentHosts(): Promise<LocalAgentHostListResponse> {
  const config = await getLocalAgentClientConfig();
  const client = initClient(zeroLocalAgentHostsContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list local-agent hosts");
}

export async function deleteLocalAgentHost(hostId: string): Promise<void> {
  const config = await getLocalAgentClientConfig();
  const client = initClient(zeroLocalAgentHostsContract, config);

  const result = await client.delete({
    params: { hostId },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to delete local-agent host");
}

export async function closeLocalAgentHost(params: {
  hostToken: string;
}): Promise<void> {
  const baseUrl = resolveLocalAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroLocalAgentHostsContract, {
    baseUrl,
    baseHeaders: buildBearerHeaders(params.hostToken),
    jsonQuery: false as const,
  });

  const result = await client.close({});

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to close local-agent host");
}

export async function getLocalAgentRun(
  jobId: string,
): Promise<LocalAgentRunResponse> {
  const config = await getLocalAgentClientConfig();
  const client = initClient(zeroLocalAgentRunContract, config);

  const result = await client.get({ params: { jobId } });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get local-agent run");
}

export async function listLocalAgentRuns(params: {
  status?: LocalAgentJobStatus;
  hostId?: string;
  hostName?: string;
  limit?: number;
}): Promise<LocalAgentRunListResponse> {
  const config = await getLocalAgentClientConfig();
  const client = initClient(zeroLocalAgentRunContract, config);

  const result = await client.list({
    headers: {},
    query: {
      ...params,
      limit: params.limit ?? 20,
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list local-agent runs");
}

export async function claimNextLocalAgentHostJob(params: {
  hostToken: string;
  supportedBackends: LocalAgentBackend[];
}): Promise<LocalAgentHostJobNextResponse> {
  const baseUrl = resolveLocalAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroLocalAgentHostJobsContract, {
    baseUrl,
    baseHeaders: buildBearerHeaders(params.hostToken),
    jsonQuery: false as const,
  });

  const result = await client.next({
    body: { supportedBackends: params.supportedBackends },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to claim local-agent job");
}

export async function completeLocalAgentHostJob(params: {
  hostToken: string;
  jobId: string;
  status: "succeeded" | "failed";
  output?: string;
  error?: string;
  exitCode?: number;
}): Promise<void> {
  const baseUrl = resolveLocalAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroLocalAgentHostJobsContract, {
    baseUrl,
    baseHeaders: buildBearerHeaders(params.hostToken),
    jsonQuery: false as const,
  });

  const result = await client.complete({
    params: { jobId: params.jobId },
    body: {
      status: params.status,
      output: params.output,
      error: params.error,
      exitCode: params.exitCode,
    },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to complete local-agent job");
}
