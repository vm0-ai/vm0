import { getApiUrl, getToken } from "../config";
import type { ApiErrorResponse } from "@vm0/core";

/**
 * Custom API request error with code and HTTP status
 */
export class ApiRequestError extends Error {
  constructor(
    message: string,
    public code: string,
    public status: number,
  ) {
    super(message);
    this.name = "ApiRequestError";
  }
}

/**
 * Get authentication headers for API requests
 */
export async function getHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
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
  jsonQuery: false;
}> {
  const baseUrl = await getBaseUrl();
  const baseHeaders = await getHeaders();
  return { baseUrl, baseHeaders, jsonQuery: false };
}

/**
 * Handle API error responses and throw appropriate error.
 *
 * Parses the server error response and throws an ApiRequestError
 * with the server's message and code. Falls back to defaultMessage
 * if the server response doesn't include an error message.
 */
export function handleError(
  result: { status: number; body: unknown },
  defaultMessage: string,
): never {
  const errorBody = result.body as ApiErrorResponse;
  const message = errorBody.error?.message || defaultMessage;
  const code = errorBody.error?.code || "UNKNOWN";
  throw new ApiRequestError(message, code, result.status);
}
