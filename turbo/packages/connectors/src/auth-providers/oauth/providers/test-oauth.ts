/**
 * Test OAuth provider — internal synthetic OAuth 2.0 connector.
 *
 * The "provider" is a set of routes under /api/test/oauth-provider/ in this
 * same application. Relative URLs are resolved from Vercel's concrete preview
 * URL or the configured app/API URL at runtime.
 *
 * For tests only: UI is hidden by FeatureSwitchKey.TestOauthConnector, and
 * the provider routes themselves 404 in production via isTestEndpointAllowed().
 */

import { z } from "zod";

import { getAuthCodeGrantConfig } from "../grant-config";
import { throwOAuthError } from "../error";
export {
  TEST_OAUTH_CLIENT_ID,
  TEST_OAUTH_CLIENT_SECRET,
  TEST_OAUTH_ACCESS_SECRET_NAME,
  TEST_OAUTH_REFRESH_SECRET_NAME,
} from "./test-oauth-constants";

const TEST_OAUTH_AUTHORIZATION_URL = "/api/test/oauth-provider/authorize";

interface TokenResponse {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
}

interface UserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

export function resolveTestOAuthProviderUrl(
  field: string,
  path: string,
): string {
  if (!path) {
    throw new Error(`Test OAuth URL missing: ${field} is not set`);
  }
  if (URL.canParse(path)) {
    return path;
  }
  const base = runtimeBaseUrl();
  return `${base}${path}`;
}

function normalizedUrl(url: string | undefined): string | undefined {
  if (!url) {
    return undefined;
  }
  const absoluteUrl = URL.canParse(url) ? url : `https://${url}`;
  return absoluteUrl.replace(/\/$/, "");
}

function isPreviewPlaceholder(url: string | undefined): boolean {
  return url?.includes("{pr}") ?? false;
}

function apiPreviewAliasFromWebUrl(
  url: string | undefined,
): string | undefined {
  const normalized = normalizedUrl(url);
  if (!normalized) {
    return undefined;
  }
  const parsed = new URL(normalized);
  if (!parsed.hostname.endsWith(".vm6.ai")) {
    return normalized;
  }
  if (!parsed.hostname.includes("-www.")) {
    return normalized;
  }
  parsed.hostname = parsed.hostname.replace("-www.", "-api.");
  return parsed.toString().replace(/\/$/, "");
}

function runtimeBaseUrl(): string {
  const configuredApiUrl = process.env.VM0_API_URL;
  if (configuredApiUrl && !isPreviewPlaceholder(configuredApiUrl)) {
    return (
      apiPreviewAliasFromWebUrl(configuredApiUrl) ?? "http://localhost:3000"
    );
  }

  const vercelUrl = normalizedUrl(process.env.VERCEL_URL);
  if (vercelUrl && isPreviewPlaceholder(configuredApiUrl)) {
    return apiPreviewAliasFromWebUrl(vercelUrl) ?? vercelUrl;
  }

  const configuredFallbackUrls = [process.env.VM0_WEB_URL, process.env.APP_URL];
  const concreteConfiguredFallbackUrl = configuredFallbackUrls.find((url) => {
    return url && !isPreviewPlaceholder(url);
  });
  if (concreteConfiguredFallbackUrl) {
    return (
      apiPreviewAliasFromWebUrl(concreteConfiguredFallbackUrl) ??
      "http://localhost:3000"
    );
  }

  if (vercelUrl) {
    return apiPreviewAliasFromWebUrl(vercelUrl) ?? vercelUrl;
  }

  if (
    isPreviewPlaceholder(configuredApiUrl) ||
    configuredFallbackUrls.some(isPreviewPlaceholder)
  ) {
    throw new Error(
      "A concrete test-oauth app URL is required when configured URL contains {pr}",
    );
  }

  return "http://localhost:3000";
}

export function testOAuthPreviewBypassHeaders(): Record<string, string> {
  return process.env.VERCEL_AUTOMATION_BYPASS_SECRET
    ? {
        "x-vercel-protection-bypass":
          process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
        "x-vm0-test-endpoint-bypass":
          process.env.VERCEL_AUTOMATION_BYPASS_SECRET,
      }
    : {};
}

function getAuthorizationUrl(): string {
  return resolveTestOAuthProviderUrl(
    "authorizationUrl",
    TEST_OAUTH_AUTHORIZATION_URL,
  );
}

function getTestOAuthTokenUrl(): string {
  return resolveTestOAuthProviderUrl(
    "tokenUrl",
    getAuthCodeGrantConfig("test-oauth").tokenUrl,
  );
}

export function buildTestOAuthAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "read",
    state,
  });
  return `${getAuthorizationUrl()}?${params.toString()}`;
}

const tokenResponseSchema = z.object({
  access_token: z.string(),
  refresh_token: z.string().nullable().optional(),
  expires_in: z.number().optional(),
  token_type: z.string().optional(),
  scope: z.string().optional(),
});

async function postToken(
  body: URLSearchParams,
  operation: "exchange" | "refresh",
): Promise<TokenResponse> {
  const response = await fetch(getTestOAuthTokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      ...testOAuthPreviewBypassHeaders(),
    },
    body,
  });

  if (!response.ok) {
    await throwOAuthError("TestOAuth", operation, response);
  }

  const data = tokenResponseSchema.parse(await response.json());

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope?.split(" ") ?? [],
  };
}

export async function exchangeTestOAuthCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
    "exchange",
  );
}

export async function refreshTestOAuthToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<TokenResponse> {
  return postToken(
    new URLSearchParams({
      grant_type: "refresh_token",
      client_id: clientId,
      client_secret: clientSecret,
      refresh_token: refreshToken,
    }),
    "refresh",
  );
}

export async function fetchTestOAuthUserInfo(
  accessToken: string,
): Promise<UserInfo> {
  // userinfo is not part of the OAuth 2 spec's token and authorization
  // endpoints, so the auth-code grant config doesn't carry it. Derive from the same app.
  const response = await fetch(
    `${runtimeBaseUrl()}/api/test/oauth-provider/userinfo`,
    {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        ...testOAuthPreviewBypassHeaders(),
      },
    },
  );

  if (!response.ok) {
    throw new Error(`Test OAuth userinfo failed: ${response.status}`);
  }

  const data = z
    .object({
      id: z.string(),
      username: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id,
    username: data.username ?? null,
    email: data.email ?? null,
  };
}
