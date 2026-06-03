import { z } from "zod";

import type { ConnectorAuthCodeGrantConfig } from "@vm0/connectors/connectors";
import { throwOAuthError } from "../error";

const STRIPE_TOKEN_URL = "https://connect.stripe.com/oauth/token";

const STRIPE_AUTHORIZATION_URL = "https://connect.stripe.com/oauth/authorize";

const STRIPE_ACCOUNT_URL = "https://api.stripe.com/v1/account";

interface StripeUserInfo {
  id: string;
  username: string | null;
  email: string | null;
}

interface StripeTokenResult {
  accessToken: string;
  refreshToken: string | null;
  scopes: string[];
  userInfo: StripeUserInfo;
}

interface StripeRefreshResult {
  accessToken: string;
  refreshToken: string | null;
  expiresIn?: number;
}

/**
 * Build Stripe Connect OAuth authorization URL.
 * Uses the Stripe Connect OAuth flow for Standard accounts.
 */
export function buildStripeAuthorizationUrl(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  clientId: string,
  redirectUri: string,
  state: string,
): string {
  const params = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: authCodeGrant.scopes.join(" "),
    state,
  });

  return `${STRIPE_AUTHORIZATION_URL}?${params.toString()}`;
}

/**
 * Exchange authorization code for access token and user info.
 * Stripe Connect returns stripe_user_id and access token in the response.
 */
export async function exchangeStripeCode(
  authCodeGrant: ConnectorAuthCodeGrantConfig,
  _clientId: string,
  clientSecret: string,
  code: string,
): Promise<StripeTokenResult> {
  const response = await fetch(STRIPE_TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_secret: clientSecret,
      code,
      grant_type: "authorization_code",
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Stripe", "exchange", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      stripe_user_id: z.string().optional(),
      scope: z.string().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Stripe response");
  }

  const stripeUserId = data.stripe_user_id ?? "";

  // Fetch account info for display name and email
  const userInfo = await fetchStripeAccountInfo(
    data.access_token,
    stripeUserId,
  );

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    scopes: data.scope ? data.scope.split(" ") : [],
    userInfo,
  };
}

/**
 * Refresh a Stripe access token using the refresh token.
 * Access token expires_in: 3600s (1 hour). Ref: https://docs.stripe.com/stripe-apps/api-authentication/oauth
 */
export async function refreshStripeToken(
  _clientId: string,
  clientSecret: string,
  refreshToken: string,
  signal: AbortSignal,
): Promise<StripeRefreshResult> {
  const response = await fetch(STRIPE_TOKEN_URL, {
    signal,
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      client_secret: clientSecret,
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  });

  if (!response.ok) {
    await throwOAuthError("Stripe", "refresh", response);
  }

  const data = z
    .object({
      access_token: z.string().optional(),
      refresh_token: z.string().nullable().optional(),
      expires_in: z.number().optional(),
      error: z.string().optional(),
      error_description: z.string().optional(),
    })
    .parse(await response.json());

  if (data.error) {
    throw new Error(data.error_description ?? data.error);
  }

  if (!data.access_token) {
    throw new Error("No access token in Stripe refresh response");
  }

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresIn: data.expires_in,
  };
}

/**
 * Fetch Stripe account info for the connected account.
 */
async function fetchStripeAccountInfo(
  accessToken: string,
  stripeUserId: string,
): Promise<StripeUserInfo> {
  const response = await fetch(STRIPE_ACCOUNT_URL, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
    },
  });

  if (!response.ok) {
    // Fall back to just the stripe_user_id if account fetch fails
    return {
      id: stripeUserId,
      username: null,
      email: null,
    };
  }

  const data = z
    .object({
      id: z.string().optional(),
      business_profile: z
        .object({
          name: z.string().nullable().optional(),
        })
        .nullable()
        .optional(),
      email: z.string().nullable().optional(),
    })
    .parse(await response.json());

  return {
    id: data.id ?? stripeUserId,
    username: data.business_profile?.name ?? null,
    email: data.email ?? null,
  };
}

/**
 * Get the primary secret name for Stripe connector (the access token).
 */
export function getStripeSecretName(): string {
  return "STRIPE_ACCESS_TOKEN";
}
