import { getApiUrl, getToken } from "../config";
import type { ApiErrorResponse } from "@vm0/core";

/**
 * Get authentication headers for API requests
 */
export async function getHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) {
    throw new Error("Not authenticated. Run: vm0 auth login");
  }

  // Note: Don't set Content-Type here - ts-rest automatically adds it for requests with body.
  // Setting Content-Type for bodyless requests (GET, DELETE) can cause server-side parsing issues.
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  // Add Vercel bypass secret if available (for CI/preview deployments)
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  return headers;
}

/**
 * Get base URL for API requests
 */
export async function getBaseUrl(): Promise<string> {
  const apiUrl = await getApiUrl();
  if (!apiUrl) {
    throw new Error("API URL not configured");
  }
  return apiUrl;
}

/**
 * Configuration for ts-rest client initialization
 */
export async function getClientConfig(): Promise<{
  baseUrl: string;
  baseHeaders: Record<string, string>;
  jsonQuery: true;
}> {
  const baseUrl = await getBaseUrl();
  const baseHeaders = await getHeaders();
  return { baseUrl, baseHeaders, jsonQuery: true };
}

/**
 * Handle API error responses and throw appropriate error
 */
export function handleError(
  result: { body: unknown },
  defaultMessage: string,
): never {
  const errorBody = result.body as ApiErrorResponse;
  const message = errorBody.error?.message || defaultMessage;
  throw new Error(message);
}
