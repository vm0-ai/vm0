/**
 * Test OAuth provider — internal synthetic OAuth 2.0 connector.
 *
 * The "provider" is a set of routes under /api/test/oauth-provider/ in this
 * same Next.js app. URLs are resolved at runtime from NEXT_PUBLIC_APP_URL —
 * the CONNECTOR_TYPES_DEF entries' URLs are documentation-only placeholders.
 *
 * For tests only: UI is hidden by FeatureSwitchKey.TestOauthConnector, and
 * the provider routes themselves 404 in production via isTestEndpointAllowed().
 */

import { getConnectorOAuthConfig } from "@vm0/api-contracts/contracts/connector-utils";
import { z } from "zod";
import { POST as tokenRouteHandler } from "../../../../../app/api/test/oauth-provider/token/route";
import { GET as userinfoRouteHandler } from "../../../../../app/api/test/oauth-provider/userinfo/route";
import { env } from "../../../../env";
import { throwOAuthError } from "./oauth-error";
export {
  TEST_OAUTH_CLIENT_ID,
  TEST_OAUTH_CLIENT_SECRET,
  TEST_OAUTH_ACCESS_SECRET_NAME,
  TEST_OAUTH_REFRESH_SECRET_NAME,
} from "./test-oauth-constants";

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

function resolveUrl(field: string, path: string | undefined): string {
  if (!path) {
    throw new Error(
      `Test OAuth URL missing: CONNECTOR_TYPES_DEF["test-oauth"].oauth.${field} is not set`,
    );
  }
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  return `${base}${path}`;
}

function getAuthorizationUrl(): string {
  return resolveUrl(
    "authorizationUrl",
    getConnectorOAuthConfig("test-oauth")?.authorizationUrl,
  );
}

function getTokenUrl(): string {
  return resolveUrl(
    "tokenUrl",
    getConnectorOAuthConfig("test-oauth")?.tokenUrl,
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

/**
 * Invoke the fake token route handler in-process.
 *
 * We intentionally do NOT round-trip through fetch(url): on Vercel preview
 * deployments, server-to-self fetches still transit the edge and hit
 * preview-deployment protection, which we'd need to carry an env-scoped
 * bypass secret past. Since this whole provider is a test fixture in the
 * same Next.js app, calling the handler directly is both simpler and
 * edge-independent. (The handler itself is env-guarded by
 * isTestEndpointAllowed so there's no new attack surface.)
 */
async function postToken(
  body: URLSearchParams,
  operation: "exchange" | "refresh",
): Promise<TokenResponse> {
  const request = new Request(getTokenUrl(), {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      // Route handler gates on isTestEndpointAllowed; mimic the preview
      // bypass header the same way the bats-side helpers do.
      ...(env().VERCEL_AUTOMATION_BYPASS_SECRET
        ? {
            "x-vercel-protection-bypass":
              env().VERCEL_AUTOMATION_BYPASS_SECRET ?? "",
          }
        : {}),
    },
    body,
  });
  const response = await tokenRouteHandler(request);

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
  // userinfo is not part of the OAuth 2 spec's tokenUrl/authorizationUrl
  // pair so ConnectorOAuthConfig doesn't carry it. Derive from the same app.
  const base = env().NEXT_PUBLIC_APP_URL.replace(/\/$/, "");
  const request = new Request(`${base}/api/test/oauth-provider/userinfo`, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      ...(env().VERCEL_AUTOMATION_BYPASS_SECRET
        ? {
            "x-vercel-protection-bypass":
              env().VERCEL_AUTOMATION_BYPASS_SECRET ?? "",
          }
        : {}),
    },
  });
  const response = await userinfoRouteHandler(request);

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
