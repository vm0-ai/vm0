import { getConnectorOAuthConfig } from "@vm0/connectors/connector-utils";
import { z } from "zod";
import { throwOAuthError } from "./oauth-error";

const MAILCHIMP_METADATA_URL = "https://login.mailchimp.com/oauth2/metadata";

interface MailchimpTokenResult {
  accessToken: string;
  scopes: string[];
  apiEndpoint: string;
  userInfo: {
    id: string;
    username: string | null;
    email: string | null;
  };
}

/**
 * Build Mailchimp OAuth authorization URL.
 * Mailchimp does not use scopes — full account access is granted.
 */
export function buildMailchimpAuthorizationUrl(
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const oauthConfig = getConnectorOAuthConfig("mailchimp");
  if (!oauthConfig) {
    throw new Error("Mailchimp OAuth config not found");
  }

  const params = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    state,
  });

  return `${oauthConfig.authorizationUrl}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token.
 * After obtaining the token, fetch metadata to get the API endpoint and user info.
 */
export async function exchangeMailchimpCode(
  clientId: string,
  clientSecret: string,
  code: string,
  redirectUri: string,
): Promise<MailchimpTokenResult> {
  const oauthConfig = getConnectorOAuthConfig("mailchimp");
  if (!oauthConfig) {
    throw new Error("Mailchimp OAuth config not found");
  }

  const response = await fetch(oauthConfig.tokenUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      client_secret: clientSecret,
      code,
      redirect_uri: redirectUri,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Mailchimp", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      error: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(`Mailchimp OAuth error: ${data.error}`);
  }

  if (!data.access_token) {
    throw new Error("No access token in Mailchimp response");
  }

  const metadata = await fetchMailchimpMetadata(data.access_token);

  return {
    accessToken: data.access_token,
    scopes: oauthConfig.scopes,
    apiEndpoint: metadata.apiEndpoint,
    userInfo: metadata.userInfo,
  };
}

/**
 * Fetch account metadata from Mailchimp OAuth metadata endpoint.
 * Returns the API endpoint (data center) and user info.
 */
async function fetchMailchimpMetadata(accessToken: string): Promise<{
  apiEndpoint: string;
  userInfo: {
    id: string;
    username: string | null;
    email: string | null;
  };
}> {
  const response = await fetch(MAILCHIMP_METADATA_URL, {
    headers: {
      Authorization: `OAuth ${accessToken}`,
    },
  });

  if (!response.ok) {
    throw new Error(
      `Mailchimp metadata fetch failed: ${response.status} ${await response.text()}`,
    );
  }

  const data = z
    .object({
      dc: z.string().optional(),
      user_id: z.number().optional(),
      accountname: z.string().nullable().optional(),
      login: z
        .object({
          login_name: z.string().nullable().optional(),
          login_email: z.string().nullable().optional(),
        })
        .optional(),
      api_endpoint: z.string().optional(),
    })
    .parse(await response.json());

  return {
    apiEndpoint: data.api_endpoint ?? "",
    userInfo: {
      id: data.user_id?.toString() ?? "",
      username: data.login?.login_name ?? data.accountname ?? null,
      email: data.login?.login_email ?? null,
    },
  };
}

/**
 * Get the primary secret name for Mailchimp connector (the access token).
 */
export function getMailchimpSecretName(): string {
  return "MAILCHIMP_ACCESS_TOKEN";
}
