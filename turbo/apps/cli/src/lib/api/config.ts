import { decodeZeroTokenPayload } from "./zero-token.js";

export async function getToken(): Promise<string | undefined> {
  return process.env.ZERO_TOKEN || undefined;
}

/**
 * Get the active token for API requests.
 * Zero is agent-only, so ZERO_TOKEN is the sole authentication source.
 */
export async function getActiveToken(): Promise<string | undefined> {
  return getToken();
}

export async function getApiUrl(): Promise<string> {
  const apiUrl = process.env.VM0_API_BACKEND_URL;
  if (apiUrl) {
    // Add protocol if missing
    return apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`;
  }
  return "https://api.vm0.ai";
}

export { decodeZeroTokenPayload };

/**
 * Get the active organization for API requests.
 * The organization is carried by the run-scoped ZERO_TOKEN.
 */
export async function getActiveOrg(): Promise<string | undefined> {
  return decodeZeroTokenPayload()?.orgId;
}
