/**
 * Type-safe secrets API client using ts-rest
 *
 * This client uses the shared contract from @vm0/core to provide
 * end-to-end type safety for secrets API calls.
 */
import { initClient, tsRestFetchApi } from "@ts-rest/core";
import { secretsContract } from "@vm0/core";
import { getApiUrl, getToken } from "./config";

async function getClientConfig() {
  const baseUrl = await getApiUrl();
  const token = await getToken();

  if (!token) {
    throw new Error("Not authenticated. Run: vm0 auth login");
  }

  const baseHeaders: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };

  // Add Vercel bypass secret if available (for CI/preview deployments)
  const bypassSecret = process.env.VERCEL_AUTOMATION_BYPASS_SECRET;
  if (bypassSecret) {
    baseHeaders["x-vercel-protection-bypass"] = bypassSecret;
  }

  return { baseUrl, baseHeaders };
}

/**
 * List all secrets for the authenticated user
 */
export async function listSecrets() {
  const config = await getClientConfig();
  const client = initClient(secretsContract, {
    ...config,
    api: tsRestFetchApi,
  });
  return client.list();
}

/**
 * Create or update a secret
 */
export async function createSecret(name: string, value: string) {
  const config = await getClientConfig();
  const client = initClient(secretsContract, {
    ...config,
    api: tsRestFetchApi,
  });
  return client.create({ body: { name, value } });
}

/**
 * Delete a secret by name
 */
export async function deleteSecret(name: string) {
  const config = await getClientConfig();
  const client = initClient(secretsContract, {
    ...config,
    api: tsRestFetchApi,
  });
  return client.delete({ query: { name } });
}

/**
 * Helper to extract error message from API response
 */
export function getErrorMessage(
  body: { error?: { message?: string } } | unknown,
  fallback: string,
): string {
  if (
    body &&
    typeof body === "object" &&
    "error" in body &&
    body.error &&
    typeof body.error === "object" &&
    "message" in body.error
  ) {
    return body.error.message as string;
  }
  return fallback;
}
