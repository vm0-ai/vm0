import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import type { StaticConfidentialConnectorAuthClient } from "../../../connector-auth-method";
import type { ConnectorAuthCodeGrantConfig } from "../../../connector-config";
import { CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS } from "../../provider-capabilities";
import { server } from "../../__tests__/test-server";
import { stripeAppsProvider, stripeProvider } from "../stripe/provider";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const TOKEN_URL = "https://connect.stripe.com/oauth/token";
const APPS_TOKEN_URL = "https://api.stripe.com/v1/oauth/token";
const ACCOUNT_URL = "https://api.stripe.com/v1/account";
const AUTH_CODE_GRANT = {
  ...authCodeGrantFixture(["read_write"]),
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
  clientSecret: "client-secret",
} satisfies StaticConfidentialConnectorAuthClient;
const APPS_AUTH_CODE_GRANT = {
  ...authCodeGrantFixture(["stripe_apps"]),
  outputs: AUTH_CODE_GRANT.outputs,
} satisfies ConnectorAuthCodeGrantConfig;

function exchangeCode() {
  return stripeProvider.grant.exchangeCode({
    authCodeGrant: AUTH_CODE_GRANT,
    authClient: TEST_AUTH_CLIENT,
    code: "auth-code",
    redirectUri: "https://example.com/callback",
  });
}

function exchangeAppsCode() {
  return stripeAppsProvider.grant.exchangeCode({
    authCodeGrant: APPS_AUTH_CODE_GRANT,
    authClient: TEST_AUTH_CLIENT,
    code: "apps-auth-code",
    redirectUri: "https://example.com/callback",
  });
}

describe("connector/providers/stripe", () => {
  it("builds a Stripe Apps install URL without Connect-only parameters", async () => {
    const result = await stripeAppsProvider.grant.buildAuthUrl({
      authCodeGrant: APPS_AUTH_CODE_GRANT,
      authClient: TEST_AUTH_CLIENT,
      redirectUri: "https://example.com/callback",
      state: "oauth-state",
    });
    if (typeof result !== "string") {
      throw new Error("Expected Stripe Apps provider to return a URL string");
    }
    const authorizationUrl = new URL(result);

    expect(authorizationUrl.origin).toBe("https://marketplace.stripe.com");
    expect(authorizationUrl.pathname).toBe("/oauth/v2/authorize");
    expect(Object.fromEntries(authorizationUrl.searchParams)).toStrictEqual({
      client_id: "client-id",
      redirect_uri: "https://example.com/callback",
      state: "oauth-state",
    });
  });

  it("exchanges a Stripe Apps code with HTTP Basic authentication", async () => {
    let authorizationHeader: string | null = null;
    let tokenBody = new URLSearchParams();
    server.use(
      http.post(APPS_TOKEN_URL, async ({ request }) => {
        authorizationHeader = request.headers.get("authorization");
        tokenBody = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: "stripe-apps-access-token",
          livemode: true,
          refresh_token: "stripe-apps-refresh-token",
          scope: "stripe_apps",
          stripe_user_id: "acct_apps",
        });
      }),
      http.get(ACCOUNT_URL, () => {
        return HttpResponse.json({
          id: "acct_apps",
          business_profile: { name: "Stripe Apps account" },
          email: "apps-owner@example.com",
        });
      }),
    );

    await expect(exchangeAppsCode()).resolves.toEqual({
      outputs: {
        accessToken: "stripe-apps-access-token",
        livemode: "true",
        refreshToken: "stripe-apps-refresh-token",
      },
      scopes: ["stripe_apps"],
      userInfo: {
        id: "acct_apps",
        username: "Stripe Apps account",
        email: "apps-owner@example.com",
      },
    });
    expect(authorizationHeader).toBe(`Basic ${btoa("client-secret:")}`);
    expect(Object.fromEntries(tokenBody)).toStrictEqual({
      code: "apps-auth-code",
      grant_type: "authorization_code",
    });
  });

  it("refreshes a Stripe Apps token with HTTP Basic authentication", async () => {
    let authorizationHeader: string | null = null;
    let tokenBody = new URLSearchParams();
    server.use(
      http.post(APPS_TOKEN_URL, async ({ request }) => {
        authorizationHeader = request.headers.get("authorization");
        tokenBody = new URLSearchParams(await request.text());
        return HttpResponse.json({
          access_token: "stripe-apps-refreshed-access-token",
          refresh_token: "stripe-apps-rolled-refresh-token",
          expires_in: 3600,
        });
      }),
    );

    await expect(
      stripeAppsProvider.access.refresh(
        {
          authClient: TEST_AUTH_CLIENT,
          inputs: { refreshToken: "stripe-apps-refresh-token" },
        },
        new AbortController().signal,
      ),
    ).resolves.toStrictEqual({
      outputs: {
        accessToken: "stripe-apps-refreshed-access-token",
        refreshToken: "stripe-apps-rolled-refresh-token",
      },
      expiresIn: 3600,
    });
    expect(authorizationHeader).toBe(`Basic ${btoa("client-secret:")}`);
    expect(Object.fromEntries(tokenBody)).toStrictEqual({
      grant_type: "refresh_token",
      refresh_token: "stripe-apps-refresh-token",
    });
  });

  it.each([
    { livemode: true, output: "true" },
    { livemode: false, output: "false" },
  ])(
    "emits OAuth livemode $livemode as the canonical string",
    async ({ livemode, output }) => {
      server.use(
        http.post(TOKEN_URL, () => {
          return HttpResponse.json({
            access_token: "stripe-access-token",
            livemode,
            refresh_token: "stripe-refresh-token",
            scope: "read_write",
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
        scopes: ["read_write"],
        userInfo: {
          id: "acct_123",
          username: "Stripe account",
          email: "owner@example.com",
        },
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

  it.each(["oauth", "app-oauth"])(
    "declares the exact Stripe %s grant outputs",
    (authMethodId) => {
      const registration = CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS.find(
        (candidate) => {
          return (
            candidate.connectorSlug === "stripe" &&
            candidate.authMethodId === authMethodId
          );
        },
      );

      expect(registration?.contract.grant.outputNames).toEqual([
        "accessToken",
        "livemode",
        "refreshToken",
      ]);
    },
  );

  it("keeps Stripe Apps credentials separate from billing credentials", () => {
    const registration = CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS.find(
      (candidate) => {
        return (
          candidate.connectorSlug === "stripe" &&
          candidate.authMethodId === "app-oauth"
        );
      },
    );

    expect(registration?.contract.client).toStrictEqual({
      kind: "static-confidential-env",
      clientIdEnv: "STRIPE_APPS_OAUTH_CLIENT_ID",
      clientSecretEnv: "STRIPE_APPS_OAUTH_CLIENT_SECRET",
    });
  });
});
