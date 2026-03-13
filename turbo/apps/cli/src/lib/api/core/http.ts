import { getBaseUrl } from "./client-factory";
import { getActiveToken, getActiveOrg } from "../config";

/**
 * Append ?org=<activeOrg> to a path if activeOrg is configured
 * and the path doesn't already include an org param.
 */
async function appendOrgParam(path: string): Promise<string> {
  const activeOrg = await getActiveOrg();
  if (!activeOrg) {
    return path;
  }

  // Check if org param already exists
  const queryStart = path.indexOf("?");
  if (queryStart !== -1) {
    const params = new URLSearchParams(path.slice(queryStart));
    if (params.has("org")) {
      return path;
    }
    return `${path}&org=${encodeURIComponent(activeOrg)}`;
  }

  return `${path}?org=${encodeURIComponent(activeOrg)}`;
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
  const orgPath = await appendOrgParam(path);

  return fetch(`${baseUrl}${orgPath}`, {
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
  const orgPath = await appendOrgParam(path);

  return fetch(`${baseUrl}${orgPath}`, {
    method: "POST",
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
  const orgPath = await appendOrgParam(path);

  return fetch(`${baseUrl}${orgPath}`, {
    method: "DELETE",
    headers,
  });
}
