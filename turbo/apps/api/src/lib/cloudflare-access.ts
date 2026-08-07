import { optionalEnv } from "./env";

export function cloudflareAccessHeadersForApiUrl(
  targetUrl: string,
): Readonly<Record<string, string>> {
  const apiUrl = optionalEnv("VM0_API_BACKEND_URL");
  if (!apiUrl || new URL(targetUrl).origin !== new URL(apiUrl).origin) {
    return {};
  }

  const clientId = optionalEnv("CF_ACCESS_CLIENT_ID");
  const clientSecret = optionalEnv("CF_ACCESS_CLIENT_SECRET");
  if (Boolean(clientId) !== Boolean(clientSecret)) {
    throw new Error(
      "Cloudflare Access credentials must be configured together",
    );
  }
  if (!clientId || !clientSecret) {
    return {};
  }

  return {
    "cf-access-client-id": clientId,
    "cf-access-client-secret": clientSecret,
  };
}
