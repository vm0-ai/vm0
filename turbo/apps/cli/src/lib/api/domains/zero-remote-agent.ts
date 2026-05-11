import { initClient } from "@ts-rest/core";
import type {
  RemoteAgentBackend,
  RemoteAgentHostJobNextResponse,
  RemoteAgentHostListResponse,
  RemoteAgentHostStartResponse,
  RemoteAgentRealtimeSubscription,
  RemoteAgentRunCreateResponse,
  RemoteAgentRunResponse,
} from "@vm0/api-contracts/contracts/zero-remote-agent";
import {
  zeroRemoteAgentHostJobsContract,
  zeroRemoteAgentHostRealtimeContract,
  zeroRemoteAgentHostsContract,
  zeroRemoteAgentHeartbeatContract,
  zeroRemoteAgentRunContract,
} from "@vm0/api-contracts/contracts/zero-remote-agent";
import {
  ApiRequestError,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";

function normalizeConfiguredUrl(value: string): string {
  return value.startsWith("http") ? value : `https://${value}`;
}

function resolveRemoteAgentApiBaseUrl(baseUrl: string): string {
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

async function getRemoteAgentClientConfig() {
  const baseUrl = resolveRemoteAgentApiBaseUrl(await getBaseUrl());
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

export async function sendRemoteAgentHeartbeat(params: {
  hostToken: string;
  hostName: string;
  supportedBackends: RemoteAgentBackend[];
}): Promise<{ hostId: string }> {
  const baseUrl = resolveRemoteAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroRemoteAgentHeartbeatContract, {
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

  handleError(result, "Failed to send remote-agent heartbeat");
}

export async function createRemoteAgentHostRealtimeSubscription(params: {
  hostToken: string;
}): Promise<RemoteAgentRealtimeSubscription> {
  const baseUrl = resolveRemoteAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroRemoteAgentHostRealtimeContract, {
    baseUrl,
    baseHeaders: buildBearerHeaders(params.hostToken),
    jsonQuery: false as const,
  });

  const result = await client.create({ body: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create remote-agent realtime subscription");
}

export async function createRemoteAgentRun(params: {
  prompt: string;
  hostName?: string;
}): Promise<RemoteAgentRunCreateResponse> {
  const config = await getRemoteAgentClientConfig();
  const client = initClient(zeroRemoteAgentRunContract, config);

  const result = await client.create({ body: params });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create remote-agent run");
}

export async function startRemoteAgentHost(params: {
  hostName: string;
  supportedBackends: RemoteAgentBackend[];
  hostId?: string;
}): Promise<RemoteAgentHostStartResponse> {
  const config = await getRemoteAgentClientConfig();
  const client = initClient(zeroRemoteAgentHostsContract, config);

  const result = await client.start({ body: params });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to start remote-agent host");
}

export async function listRemoteAgentHosts(): Promise<RemoteAgentHostListResponse> {
  const config = await getRemoteAgentClientConfig();
  const client = initClient(zeroRemoteAgentHostsContract, config);

  const result = await client.list();

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list remote-agent hosts");
}

export async function deleteRemoteAgentHost(hostId: string): Promise<void> {
  const config = await getRemoteAgentClientConfig();
  const client = initClient(zeroRemoteAgentHostsContract, config);

  const result = await client.delete({
    params: { hostId },
  });

  if (result.status === 200) {
    return;
  }

  handleError(result, "Failed to delete remote-agent host");
}

export async function getRemoteAgentRun(
  jobId: string,
): Promise<RemoteAgentRunResponse> {
  const config = await getRemoteAgentClientConfig();
  const client = initClient(zeroRemoteAgentRunContract, config);

  const result = await client.get({ params: { jobId } });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get remote-agent run");
}

export async function claimNextRemoteAgentHostJob(params: {
  hostToken: string;
  supportedBackends: RemoteAgentBackend[];
}): Promise<RemoteAgentHostJobNextResponse> {
  const baseUrl = resolveRemoteAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroRemoteAgentHostJobsContract, {
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

  handleError(result, "Failed to claim remote-agent job");
}

export async function completeRemoteAgentHostJob(params: {
  hostToken: string;
  jobId: string;
  status: "succeeded" | "failed";
  output?: string;
  error?: string;
  exitCode?: number;
}): Promise<void> {
  const baseUrl = resolveRemoteAgentApiBaseUrl(await getBaseUrl());
  const client = initClient(zeroRemoteAgentHostJobsContract, {
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

  handleError(result, "Failed to complete remote-agent job");
}
