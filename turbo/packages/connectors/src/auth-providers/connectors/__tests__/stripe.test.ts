import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import {
  connectorAuthClientIdentity,
  type StaticConfidentialConnectorAuthClient,
} from "../../../connector-auth-method";
import type { ConnectorAuthCodeGrantConfig } from "../../../connector-config";
import { CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS } from "../../provider-capabilities";
import { server } from "../../__tests__/test-server";
import { stripeProvider } from "../stripe/provider";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const AUTHORIZATION_URL = "https://marketplace.stripe.com/oauth/v2/authorize";
const TOKEN_URL = "https://api.stripe.com/v1/oauth/token";
const ACCOUNT_URL = "https://api.stripe.com/v1/account";
const STRIPE_MARKETPLACE_PERMISSIONS = [
  "charge_read",
  "charge_write",
  "checkout_session_read",
  "checkout_session_write",
  "customer_read",
  "customer_write",
  "payment_intent_read",
  "payment_intent_write",
  "payment_links_read",
  "payment_links_write",
  "plan_read",
  "plan_write",
  "product_read",
  "product_write",
  "setup_intent_read",
  "setup_intent_write",
  "subscription_read",
  "subscription_write",
  "balance_read",
  "event_read",
  "invoice_read",
  "payment_method_read",
] as const;
const AUTH_CODE_GRANT = {
  ...authCodeGrantFixture(STRIPE_MARKETPLACE_PERMISSIONS),
  outputs: {
    accessToken: "$secrets.STRIPE_ACCESS_TOKEN",
    livemode: "$vars.STRIPE_LIVEMODE",
    refreshToken: "$secrets.STRIPE_REFRESH_TOKEN",
  },
} satisfies ConnectorAuthCodeGrantConfig;
const TEST_AUTH_CLIENT = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "client-id",
  clientSecret: "sk_test_marketplace_secret",
} satisfies StaticConfidentialConnectorAuthClient;

function exchangeCode() {
  return stripeProvider.grant.exchangeCode({
    authCodeGrant: AUTH_CODE_GRANT,
    authClient: TEST_AUTH_CLIENT,
    code: "ac_test_authorization_code",
    redirectUri: "https://example.com/callback",
  });
}

function testRefreshSignal(): AbortSignal {
  return new AbortController().signal;
}

describe("connector/providers/stripe", () => {
  it("builds a Stripe Marketplace authorization URL without legacy Connect parameters", () => {
    const url = stripeProvider.grant.buildAuthUrl({
      authCodeGrant: AUTH_CODE_GRANT,
      authClient: connectorAuthClientIdentity(TEST_AUTH_CLIENT),
      redirectUri: "https://example.com/callback",
      state: "oauth-state",
    });
    if (typeof url !== "string") {
      throw new Error("Expected Stripe Marketplace auth URL to be a string");
    }

    expect(url).toBe(
      `${AUTHORIZATION_URL}?client_id=client-id&redirect_uri=https%3A%2F%2Fexample.com%2Fcallback&state=oauth-state`,
    );
    expect(new URL(url).searchParams.has("response_type")).toBe(false);
    expect(new URL(url).searchParams.has("scope")).toBe(false);
  });

  it.each([
    { livemode: true, output: "true" },
    { livemode: false, output: "false" },
  ])(
    "emits OAuth livemode $livemode as the canonical string",
    async ({ livemode, output }) => {
      let authorization: string | null = null;
      let tokenRequestBody: URLSearchParams | null = null;
      server.use(
        http.post(TOKEN_URL, async ({ request }) => {
          authorization = request.headers.get("authorization");
          tokenRequestBody = new URLSearchParams(await request.text());
          return HttpResponse.json({
            access_token: "stripe-access-token",
            expires_in: 3600,
            livemode,
            refresh_token: "stripe-refresh-token",
            scope: "stripe_apps",
            stripe_user_id: "acct_123",
          });
        }),
        http.get(ACCOUNT_URL, () => {
          return HttpResponse.json({
            id: "acct_123",
            business_profile: { name: "Stripe account" },
            email: "owner@example.com",
          });
        }),
      );

      await expect(exchangeCode()).resolves.toEqual({
        outputs: {
          accessToken: "stripe-access-token",
          livemode: output,
          refreshToken: "stripe-refresh-token",
        },
        expiresIn: 3600,
        scopes: [...STRIPE_MARKETPLACE_PERMISSIONS],
        userInfo: {
          id: "acct_123",
          username: "Stripe account",
          email: "owner@example.com",
        },
      });
      expect(authorization).toBe(
        `Basic ${btoa("sk_test_marketplace_secret:")}`,
      );
      expect(Object.fromEntries(tokenRequestBody ?? [])).toStrictEqual({
        code: "ac_test_authorization_code",
        grant_type: "authorization_code",
      });
    },
  );

  it("rejects an OAuth token response without livemode", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "stripe-access-token",
          refresh_token: "stripe-refresh-token",
          stripe_user_id: "acct_123",
        });
      }),
    );

    await expect(exchangeCode()).rejects.toThrow(/livemode/u);
  });

  it("rejects a non-Boolean OAuth livemode", async () => {
    server.use(
      http.post(TOKEN_URL, () => {
        return HttpResponse.json({
          access_token: "stripe-access-token",
          livemode: "true",
          refresh_token: "stripe-refresh-token",
          stripe_user_id: "acct_123",
        });
      }),
    );

    await expect(exchangeCode()).rejects.toThrow(/livemode/u);
  });

  it("refreshes a Marketplace access token with Basic auth and rotates the refresh token", async () => {
    let authorization: string | null = null;
    let tokenRequestBody: URLSearchParams | null = null;
    server.use(
      http.post(TOKEN_URL, async ({ request }) => {
        authorization = request.headers.get("authorization");
        tokenRequestBody = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: "refreshed-stripe-access-token",
          expires_in: 3600,
          refresh_token: "rotated-stripe-refresh-token",
          scope: "stripe_apps",
        });
      }),
    );

    await expect(
      stripeProvider.access.refresh(
        {
          authClient: TEST_AUTH_CLIENT,
          inputs: { refreshToken: "stripe-refresh-token" },
        },
        testRefreshSignal(),
      ),
    ).resolves.toEqual({
      outputs: {
        accessToken: "refreshed-stripe-access-token",
        refreshToken: "rotated-stripe-refresh-token",
      },
      expiresIn: 3600,
    });
    expect(authorization).toBe(`Basic ${btoa("sk_test_marketplace_secret:")}`);
    expect(Object.fromEntries(tokenRequestBody ?? [])).toStrictEqual({
      grant_type: "refresh_token",
      refresh_token: "stripe-refresh-token",
    });
  });

  it("declares the Marketplace OAuth client config and exact grant outputs", () => {
    const registration = CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS.find(
      (candidate) => {
        return (
          candidate.connectorSlug === "stripe" &&
          candidate.authMethodId === "oauth"
        );
      },
    );

    expect(registration?.contract.client).toStrictEqual({
      kind: "static-confidential-env",
      clientIdEnv: "STRIPE_OAUTH_CLIENT_ID",
      clientSecretEnv: "STRIPE_OAUTH_CLIENT_SECRET",
    });
    expect(registration?.contract.grant.outputNames).toEqual([
      "accessToken",
      "livemode",
      "refreshToken",
    ]);
  });
});
