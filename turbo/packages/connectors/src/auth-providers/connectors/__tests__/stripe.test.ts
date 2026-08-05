import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";

import type { StaticConfidentialConnectorAuthClient } from "../../../connector-auth-method";
import type { ConnectorAuthCodeGrantConfig } from "../../../connector-config";
import { CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS } from "../../provider-capabilities";
import { server } from "../../__tests__/test-server";
import { stripeProvider } from "../stripe/provider";
import { authCodeGrantFixture } from "./auth-code-grant-fixture";

const TOKEN_URL = "https://connect.stripe.com/oauth/token";
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

function exchangeCode() {
  return stripeProvider.grant.exchangeCode({
    authCodeGrant: AUTH_CODE_GRANT,
    authClient: TEST_AUTH_CLIENT,
    code: "auth-code",
    redirectUri: "https://example.com/callback",
  });
}

describe("connector/providers/stripe", () => {
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

  it("declares the exact Stripe OAuth grant outputs", () => {
    const registration = CONNECTOR_AUTH_PROVIDER_METHOD_REGISTRATIONS.find(
      (candidate) => {
        return (
          candidate.connectorSlug === "stripe" &&
          candidate.authMethodId === "oauth"
        );
      },
    );

    expect(registration?.contract.grant.outputNames).toEqual([
      "accessToken",
      "livemode",
      "refreshToken",
    ]);
  });
});
