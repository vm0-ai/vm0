import type { UsageResponse } from "../core/types";
import { getApiUrl, getToken } from "../config";

export async function getUsage(options: {
  startDate: string;
  endDate: string;
}): Promise<UsageResponse> {
  const baseUrl = await getApiUrl();
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

  const params = new URLSearchParams({
    start_date: options.startDate,
    end_date: options.endDate,
  });

  const response = await fetch(`${baseUrl}/api/usage?${params}`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const error = (await response.json()) as { error?: { message?: string } };
    throw new Error(error.error?.message || "Failed to fetch usage data");
  }

  return response.json() as Promise<UsageResponse>;
}
