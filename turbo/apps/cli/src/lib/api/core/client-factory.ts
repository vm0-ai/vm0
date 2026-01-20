import { initClient } from "@ts-rest/core";
import type { ApiErrorResponse } from "@vm0/core";
import { getApiUrl, getToken } from "../config";

interface ClientConfig {
  baseUrl: string;
  baseHeaders: Record<string, string>;
  jsonQuery: true;
}

async function getHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Run: vm0 auth login");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  return headers;
}

async function getBaseUrl(): Promise<string> {
  const apiUrl = await getApiUrl();
  if (!apiUrl) {
    throw new Error("API URL not configured");
  }
  return apiUrl;
}

export async function getClientConfig(): Promise<ClientConfig> {
  const baseUrl = await getBaseUrl();
  const baseHeaders = await getHeaders();
  return { baseUrl, baseHeaders, jsonQuery: true };
}

export function createClient<T extends Parameters<typeof initClient>[0]>(
  contract: T,
  config: ClientConfig,
) {
  return initClient(contract, config);
}

export function handleError(
  result: { body: unknown },
  defaultMessage: string,
): never {
  const errorBody = result.body as ApiErrorResponse;
  const message = errorBody.error?.message || defaultMessage;
  throw new Error(message);
}
