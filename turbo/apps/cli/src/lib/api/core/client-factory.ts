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
  jsonQuery: false;
}> {
  const baseUrl = await getBaseUrl();
  const baseHeaders = await getHeaders();
  return { baseUrl, baseHeaders, jsonQuery: false };
}

/**
 * Handle API error responses and throw appropriate error.
 *
 * By default, 401/403 responses are mapped to user-friendly messages.
 * Pass `useServerMessage: true` to preserve the original server error
 * message (e.g., for domain-specific 403 like "slug is reserved").
 */
export function handleError(
  result: { status: number; body: unknown },
  defaultMessage: string,
  options?: { useServerMessage?: boolean },
): never {
  if (!options?.useServerMessage) {
    if (result.status === 401) {
      throw new ApiRequestError(
        "Not authenticated. Run: vm0 auth login",
        "UNAUTHORIZED",
        401,
      );
    }

    if (result.status === 403) {
      throw new ApiRequestError(
        "An unexpected network issue occurred",
        "FORBIDDEN",
        403,
      );
    }
  }

  const errorBody = result.body as ApiErrorResponse;
  const message = errorBody.error?.message || defaultMessage;
  const code = errorBody.error?.code || "UNKNOWN";
  throw new ApiRequestError(message, code, result.status);
}
