import { getConnectorOAuthConfig } from "@vm0/core";
import { z } from "zod";

const DOCUSIGN_USERINFO_URL = "https://account.docusign.com/oauth/userinfo";

interface DocuSignUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface DocuSignTokenResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
  scopes: string[];
  userInfo: DocuSignUserInfo;
}

interface DocuSignRefreshResult {
  accessToken: string;
  refreshToken: string | null;
}

/**
 * Build DocuSign OAuth authorization URL.
 * Requests offline access to obtain a refresh token.
 */
export function buildDocuSignAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("docusign");
  if (!oauthConfig) {
    throw new Error("DocuSign OAuth config not found");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: oauthConfig.scopes.join(" "),
    state,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * DocuSign uses Basic auth (Base64 of clientId:clientSecret) for token exchange.
 */
export async function exchangeDocuSignCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<DocuSignTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("docusign");
  if (!oauthConfig) {
    throw new Error("DocuSign OAuth config not found");
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      code,
      redirect_uri: redirectUri,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    throw new Error(`DocuSign token exchange failed: ${response.status}`);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in DocuSign response");
  }

  const userInfo = await fetchDocuSignUserInfo(data.access_token);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh a DocuSign access token using the refresh token.
 * DocuSign uses Basic Auth for token requests.
 * Returns new access token and new refresh token (both must be stored).
 */
export async function refreshDocuSignToken(
  clientId: string,
  clientSecret: string,
  refreshToken: string,
): Promise<DocuSignRefreshResult> {
  const oauthConfig = getConnectorOAuthConfig("docusign");
  if (!oauthConfig) {
    throw new Error("DocuSign OAuth config not found");
  }

  const basicAuth = Buffer.from(`${clientId}:${clientSecret}`).toString(
    "base64",
  );

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Authorization: `Basic ${basicAuth}`,
    },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    throw new Error(`DocuSign token refresh failed: ${response.status}`);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in DocuSign refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
  };
}

/**
 * Fetch DocuSign user info using the OAuth userinfo endpoint.
 */
async function fetchDocuSignUserInfo(
  accessToken: string,
): Promise<DocuSignUserInfo> {
  const response = await fetch(DOCUSIGN_USERINFO_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(`DocuSign user info fetch failed: ${response.status}`);
  }

  const data = z
    .object({
      sub: z.string().optional(),
      name: z.string().nullable().optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.sub ?? "",
    username: data.name ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for DocuSign connector (the access token).
 */
export function getDocuSignSecretName(): string {
  return "DOCUSIGN_ACCESS_TOKEN";
}
