import type { PublicBrand } from "@okouai/api-contracts/contracts/public-brand";
import { decodeSandboxTokenPayload } from "./sandbox-token.js";
import { getOkouToken } from "../okou-env.js";

export async function getToken(): Promise<string | undefined> {
  return getOkouToken();
}

/**
 * Get the active token for API requests.
 * Agent runs use OKOU_TOKEN.
 */
export async function getActiveToken(): Promise<string | undefined> {
  return getToken();
}

export async function getApiUrl(): Promise<string> {
  const apiUrl = process.env.OKOU_API_BACKEND_URL;
  if (apiUrl) {
    // Add protocol if missing
    return apiUrl.startsWith("http") ? apiUrl : `https://${apiUrl}`;
  }
  return "https://api.okou.ai";
}

export function getCliPublicBrand(): PublicBrand {
  const runToken = decodeSandboxTokenPayload();
  if (runToken) {
    return runToken.publicBrand ?? "vm0";
  }

  const configuredApiUrl = process.env.OKOU_API_BACKEND_URL;
  if (!configuredApiUrl) {
    return "okou";
  }
  const url = new URL(
    configuredApiUrl.startsWith("http")
      ? configuredApiUrl
      : `https://${configuredApiUrl}`,
  );
  return url.hostname === "api.vm0.ai" ? "vm0" : "okou";
}

export { decodeSandboxTokenPayload };

/**
 * Get the active organization for API requests.
 * The organization is carried by the run-scoped agent token.
 */
export async function getActiveOrg(): Promise<string | undefined> {
  return decodeSandboxTokenPayload()?.orgId;
}
