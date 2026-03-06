import { getBaseUrl } from "./client-factory";
import { getActiveToken, loadConfig } from "../config";

/**
 * Append ?scope=<activeScope> to a path if activeScope is configured
 * and the path doesn't already include a scope param.
 */
async function appendScopeParam(path: string): Promise<string> {
  const config = await loadConfig();
  const activeScope = config.activeScope;
  if (!activeScope) {
    return path;
  }

  // Check if scope param already exists
  const queryStart = path.indexOf("?");
  if (queryStart !== -1) {
    const params = new URLSearchParams(path.slice(queryStart));
    if (params.has("scope")) {
      return path;
    }
    return `${path}&scope=${encodeURIComponent(activeScope)}`;
  }

  return `${path}?scope=${encodeURIComponent(activeScope)}`;
}

/**
 * Get headers for raw HTTP requests (used for non-ts-rest endpoints)
 */
async function getRawHeaders(): Promise<Record<string, string>> {
  const token = await getActiveToken();
  if (!token) {
    throw new Error("Not authenticated. Run: vm0 auth login");
  }

  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  // Add Vercel bypass secret if available
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }

  return headers;
}

/**
 * Generic GET request
 */
export async function httpGet(path: string): Promise<Response> {
  const baseUrl = await getBaseUrl();
  const headers = await getRawHeaders();
  const scopedPath = await appendScopeParam(path);

  return fetch(`${baseUrl}${scopedPath}`, {
    method: "GET",
    headers,
  });
}

/**
 * Generic POST request
 */
export async function httpPost(path: string, body: unknown): Promise<Response> {
  const baseUrl = await getBaseUrl();
  const headers = await getRawHeaders();
  const scopedPath = await appendScopeParam(path);

  return fetch(`${baseUrl}${scopedPath}`, {
    method: "POST",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Generic PUT request
 */
export async function httpPut(path: string, body: unknown): Promise<Response> {
  const baseUrl = await getBaseUrl();
  const headers = await getRawHeaders();
  const scopedPath = await appendScopeParam(path);

  return fetch(`${baseUrl}${scopedPath}`, {
    method: "PUT",
    headers: {
      ...headers,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

/**
 * Generic DELETE request
 */
export async function httpDelete(path: string): Promise<Response> {
  const baseUrl = await getBaseUrl();
  const headers = await getRawHeaders();
  const scopedPath = await appendScopeParam(path);

  return fetch(`${baseUrl}${scopedPath}`, {
    method: "DELETE",
    headers,
  });
}
