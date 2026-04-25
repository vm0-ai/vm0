import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const stripe = {
  stripe: {
    label: "Stripe",
    category: "data-automation-infrastructure",
    tags: ["payments", "billing", "checkout"],
    environmentMapping: {
      STRIPE_TOKEN: "$secrets.STRIPE_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.StripeConnector,
    helpText:
      "Connect your Stripe account to manage payments, customers, and subscriptions",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Stripe to grant access.",
        secrets: {
          STRIPE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          STRIPE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: false,
          },
        },
      },
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Stripe Dashboard](https://dashboard.stripe.com/apikeys)\n2. Go to **Developers > API keys**\n3. Reveal the **Secret key** (starts with `sk_live_` or `sk_test_`) or create a **Restricted key** (`rk_live_...`) with the scopes you need\n4. Copy the key",
        secrets: {
          STRIPE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk_live_...",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://connect.stripe.com/oauth/authorize",
      tokenUrl: "https://connect.stripe.com/oauth/token",
      scopes: ["read_write"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
