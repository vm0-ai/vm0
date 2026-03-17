import { getBaseUrl, getHeaders, handleError } from "../core/client-factory";
import { getActiveOrg } from "../config";
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

  const activeOrg = await getActiveOrg();
  if (!activeOrg) {
    throw new Error(
      "No active organization configured. Run: vm0 org use <slug>",
    );
  }

  const params = new URLSearchParams({
    start_date: options.startDate,
    end_date: options.endDate,
    org: activeOrg,
  });

  const response = await fetch(`${baseUrl}/api/usage?${params}`, {
    method: "GET",
    headers,
  });

  if (!response.ok) {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    handleError(
      { status: response.status, body },
      "Failed to fetch usage data",
    );
  }

  return response.json() as Promise<UsageResponse>;
}
