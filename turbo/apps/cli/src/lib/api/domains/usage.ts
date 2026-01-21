import { getBaseUrl, getHeaders } from "../core/client-factory";
import type { UsageResponse } from "../core/types";

/**
 * Get usage statistics
 */
export async function getUsage(options: {
  startDate: string;
  endDate: string;
}): Promise<UsageResponse> {
  const baseUrl = await getBaseUrl();
  const headers = await getHeaders();

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
