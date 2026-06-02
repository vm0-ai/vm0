import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

const OAUTH_TOKEN_URL = "https://connect.stripe.com/oauth/token";

export const stripe = {
  stripe: {
    label: "Stripe",
    category: "data-automation-infrastructure",
    tags: ["payments", "billing", "checkout"],
    helpText:
      "Connect your Stripe account to manage payments, customers, and subscriptions",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.StripeConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Stripe to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "STRIPE_OAUTH_CLIENT_ID",
          clientSecretEnv: "STRIPE_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: ["read_write"],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          accessToken: "STRIPE_ACCESS_TOKEN",
          refreshToken: "STRIPE_REFRESH_TOKEN",
          envBindings: {
            STRIPE_TOKEN: "$secrets.STRIPE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Stripe Dashboard](https://dashboard.stripe.com/apikeys)\n2. Go to **Developers > API keys**\n3. Reveal the **Secret key** (starts with `sk_live_` or `sk_test_`) or create a **Restricted key** (`rk_live_...`) with the scopes you need\n4. Copy the key",
        grant: {
          kind: "manual",
          fields: {
            STRIPE_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "sk_live_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            STRIPE_TOKEN: "$secrets.STRIPE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
