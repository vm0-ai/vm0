import { initClient } from "@ts-rest/core";
import type {
  LocalBrowserCommandCreateResponse,
  LocalBrowserCommandResponse,
  LocalBrowserAuditEventListResponse,
  LocalBrowserHostDeleteResponse,
  LocalBrowserHostListResponse,
  LocalBrowserReadCommandKind,
  LocalBrowserWriteCommandKind,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import {
  zeroLocalBrowserAuditEventsContract,
  zeroLocalBrowserCommandContract,
  zeroLocalBrowserHostsContract,
  zeroLocalBrowserWriteCommandContract,
} from "@vm0/api-contracts/contracts/zero-local-browser";
import {
  ApiRequestError,
  getBaseUrl,
  handleError,
} from "../core/client-factory";
import { getActiveToken } from "../config";

function normalizeConfiguredUrl(value: string): string {
  return value.startsWith("http") ? value : `https://${value}`;
}

function resolveLocalBrowserApiBaseUrl(baseUrl: string): string {
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

async function getLocalBrowserClientConfig() {
  const baseUrl = resolveLocalBrowserApiBaseUrl(await getBaseUrl());
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  return {
    baseUrl,
    baseHeaders: buildHeaders(token),
    jsonQuery: false as const,
  };
}

export async function createLocalBrowserReadCommand(params: {
  kind: LocalBrowserReadCommandKind;
  tabId?: string;
  hostId?: string;
  hostName?: string;
  timeoutMs?: number;
}): Promise<LocalBrowserCommandCreateResponse> {
  const config = await getLocalBrowserClientConfig();
  const client = initClient(zeroLocalBrowserCommandContract, config);

  const result = await client.create({
    body: {
      kind: params.kind,
      timeoutMs: params.timeoutMs ?? 15_000,
      ...(params.tabId ? { tabId: params.tabId } : {}),
      ...(params.hostId ? { hostId: params.hostId } : {}),
      ...(params.hostName ? { hostName: params.hostName } : {}),
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create local-browser command");
}

export async function createLocalBrowserWriteCommand(params: {
  kind: LocalBrowserWriteCommandKind;
  tabId?: string;
  hostId?: string;
  hostName?: string;
  selector?: string;
  x?: number;
  y?: number;
  text?: string;
  direction?: "up" | "down";
  amount?: number;
  url?: string;
  timeoutMs?: number;
}): Promise<LocalBrowserCommandCreateResponse> {
  const config = await getLocalBrowserClientConfig();
  const client = initClient(zeroLocalBrowserWriteCommandContract, config);

  const result = await client.create({
    body: {
      kind: params.kind,
      timeoutMs: params.timeoutMs ?? 15_000,
      ...(params.tabId ? { tabId: params.tabId } : {}),
      ...(params.hostId ? { hostId: params.hostId } : {}),
      ...(params.hostName ? { hostName: params.hostName } : {}),
      ...(params.selector ? { selector: params.selector } : {}),
      ...(params.x !== undefined ? { x: params.x } : {}),
      ...(params.y !== undefined ? { y: params.y } : {}),
      ...(params.text ? { text: params.text } : {}),
      ...(params.direction ? { direction: params.direction } : {}),
      ...(params.amount !== undefined ? { amount: params.amount } : {}),
      ...(params.url ? { url: params.url } : {}),
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to create local-browser write command");
}

export async function getLocalBrowserReadCommand(
  commandId: string,
): Promise<LocalBrowserCommandResponse> {
  const config = await getLocalBrowserClientConfig();
  const client = initClient(zeroLocalBrowserCommandContract, config);

  const result = await client.get({ params: { commandId } });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to get local-browser command");
}

export async function listLocalBrowserHosts(): Promise<LocalBrowserHostListResponse> {
  const config = await getLocalBrowserClientConfig();
  const client = initClient(zeroLocalBrowserHostsContract, config);

  const result = await client.list({ headers: {} });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list local-browser hosts");
}

export async function deleteLocalBrowserHost(
  hostId: string,
): Promise<LocalBrowserHostDeleteResponse> {
  const config = await getLocalBrowserClientConfig();
  const client = initClient(zeroLocalBrowserHostsContract, config);

  const result = await client.delete({ params: { hostId } });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to revoke local-browser host");
}

export async function listLocalBrowserAuditEvents(params: {
  readonly limit?: number;
  readonly commandId?: string;
  readonly hostId?: string;
  readonly runId?: string;
}): Promise<LocalBrowserAuditEventListResponse> {
  const config = await getLocalBrowserClientConfig();
  const client = initClient(zeroLocalBrowserAuditEventsContract, config);

  const result = await client.list({
    query: {
      limit: params.limit ?? 50,
      ...(params.commandId ? { commandId: params.commandId } : {}),
      ...(params.hostId ? { hostId: params.hostId } : {}),
      ...(params.runId ? { runId: params.runId } : {}),
    },
  });

  if (result.status === 200) {
    return result.body;
  }

  handleError(result, "Failed to list local-browser audit events");
}
