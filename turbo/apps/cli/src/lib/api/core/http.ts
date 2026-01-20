import { getApiUrl, getToken } from "../config";

async function getAuthHeaders(): Promise<Record<string, string>> {
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

export async function httpGet(path: string): Promise<Response> {
  const baseUrl = await getApiUrl();
  const headers = await getAuthHeaders();

  return fetch(`${baseUrl}${path}`, {
    method: "GET",
    headers,
  });
}
