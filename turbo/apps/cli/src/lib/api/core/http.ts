import { getBaseUrl } from "./client-factory";
import { getToken } from "../config";

/**
 * Get headers for raw HTTP requests (used for non-ts-rest endpoints)
 */
async function getRawHeaders(): Promise<Record<string, string>> {
  const token = await getToken();
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

  return fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers,
  });
}
