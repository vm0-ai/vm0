import { ApiRequestError, getBaseUrl } from "../core/client-factory";
import { getActiveToken } from "../config";

export type ZeroBankingOperation = "accounts" | "balances" | "transactions";

export interface ZeroBankingResponse {
  readonly operation: ZeroBankingOperation;
  readonly provider: "finicity";
  readonly accounts?: unknown[];
  readonly balance?: unknown;
  readonly accountId?: string;
  readonly transactions?: unknown[];
}

function authenticatedJsonHeaders(token: string): Record<string, string> {
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function parseErrorBody(
  response: Response,
): Promise<{ message: string; code: string }> {
  let message = `Zero Banking request failed (HTTP ${response.status})`;
  let code = response.status === 404 ? "NOT_FOUND" : "UNKNOWN";

  try {
    const body: unknown = await response.json();
    if (isRecord(body) && isRecord(body.error)) {
      if (typeof body.error.message === "string") {
        message = body.error.message;
      }
      if (typeof body.error.code === "string") {
        code = body.error.code;
      }
    }
  } catch {
    // Keep the status-based fallback when the response is not JSON.
  }

  if (response.status === 404 && code === "NOT_FOUND") {
    message =
      "Zero Banking API is not available on this server yet. Try again after the banking backend is deployed.";
  }

  return { message, code };
}

export async function callZeroBanking(
  operation: ZeroBankingOperation,
  body: Record<string, unknown>,
): Promise<ZeroBankingResponse> {
  const baseUrl = await getBaseUrl();
  const token = await getActiveToken();
  if (!token) {
    throw new ApiRequestError("Not authenticated", "UNAUTHORIZED", 401);
  }

  const response = await fetch(
    new URL(`/api/zero/banking/${operation}`, baseUrl),
    {
      method: "POST",
      headers: authenticatedJsonHeaders(token),
      body: JSON.stringify(body),
    },
  );

  if (!response.ok) {
    const { message, code } = await parseErrorBody(response);
    throw new ApiRequestError(message, code, response.status);
  }

  return (await response.json()) as ZeroBankingResponse;
}
