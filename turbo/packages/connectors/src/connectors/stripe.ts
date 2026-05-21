import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const stripe = {
  stripe: {
    label: "Stripe",
    category: "data-automation-infrastructure",
    tags: ["payments", "billing", "checkout"],
    environmentMapping: {
      STRIPE_TOKEN: "$secrets.STRIPE_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Stripe account to manage payments, customers, and subscriptions",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.StripeConnector,
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
      "cli-auth": {
        featureFlag: FeatureSwitchKey.CliAuthStripe,
        label: "Sign in with Stripe",
        helpText: "Approve access in Stripe to import an API key.",
        secrets: {},
      },
    },
    defaultAuthMethod: "oauth",
    cliAuth: {
      flow: "browser-verification",
      modes: [
        {
          value: "test",
          label: "Test mode",
          description: "Import a Stripe test mode key.",
        },
        {
          value: "live",
          label: "Live mode",
          description: "Import a Stripe live mode key.",
        },
      ],
    },
    oauth: {
      flow: "authorization-code",
      tokenUrl: "https://connect.stripe.com/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "STRIPE_OAUTH_CLIENT_ID",
        clientSecretEnv: "STRIPE_OAUTH_CLIENT_SECRET",
      },
      scopes: ["read_write"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
