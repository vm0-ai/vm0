import type {
  HostedSitePrepareRequest,
  HostedSitePrepareResponse,
  HostedSiteCompleteResponse,
} from "@vm0/api-contracts/contracts/zero-host";
import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";

function authHeaders(token: string): Record<string, string> {
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
    "Content-Type": "application/json",
  };
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    headers["x-vercel-protection-bypass"] = bypassSecret;
  }
  return headers;
}

async function parseErrorBody(
  response: Response,
  fallback: string,
): Promise<{ message: string; code: string }> {
  let message = `${fallback} (HTTP ${response.status})`;
  let code = "UNKNOWN";
  try {
    const body = (await response.json()) as {
      error?: { message?: string; code?: string };
    };
    if (body.error?.message) message = body.error.message;
    if (body.error?.code) code = body.error.code;
  } catch {
    // keep fallback
  }
  return { message, code };
}

async function getAuthContext(): Promise<{
  readonly baseUrl: string;
  readonly token: string;
}> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }
  return { baseUrl, token };
}

export async function prepareHostedSite(
  body: HostedSitePrepareRequest,
): Promise<HostedSitePrepareResponse> {
  const { baseUrl, token } = await getAuthContext();
  const response = await fetch(
    new URL("/api/zero/host/deployments/prepare", baseUrl),
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to prepare hosted-site deployment",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return (await response.json()) as HostedSitePrepareResponse;
}

export async function completeHostedSite(
  deploymentId: string,
): Promise<HostedSiteCompleteResponse> {
  const { baseUrl, token } = await getAuthContext();
  const response = await fetch(
    new URL(
      `/api/zero/host/deployments/${encodeURIComponent(deploymentId)}/complete`,
      baseUrl,
    ),
    {
      method: "POST",
      headers: authHeaders(token),
      body: JSON.stringify({}),
    },
  );
  if (!response.ok) {
    const { message, code } = await parseErrorBody(
      response,
      "Failed to complete hosted-site deployment",
    );
    throw new ApiRequestError(message, code, response.status);
  }
  return (await response.json()) as HostedSiteCompleteResponse;
}
