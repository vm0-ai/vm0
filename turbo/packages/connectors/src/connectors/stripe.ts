import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

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
        storage: {
          secrets: ["STRIPE_ACCESS_TOKEN", "STRIPE_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: ["read_write"],
          outputs: {
            accessToken: "$secrets.STRIPE_ACCESS_TOKEN",
            refreshToken: "$secrets.STRIPE_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.STRIPE_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.STRIPE_ACCESS_TOKEN",
            refreshToken: "$secrets.STRIPE_REFRESH_TOKEN",
          },
          refreshableSecrets: ["STRIPE_ACCESS_TOKEN"],
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
        storage: {
          secrets: ["STRIPE_TOKEN"],
          variables: [],
        },
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
      cli: {
        label: "Sign in with Stripe",
        helpText:
          "Approve access in the Stripe Dashboard so vm0 can import a restricted API key.",
        client: {
          clientRegistration: "dynamic",
          clientType: "public",
        },
        storage: {
          secrets: ["STRIPE_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "device-auth",
          scopes: [],
          outputs: {
            token: "$secrets.STRIPE_TOKEN",
          },
          startOptions: {
            mode: {
              kind: "select",
              label: "Mode",
              required: true,
              defaultValue: "test",
              options: [
                { value: "test", label: "Test" },
                { value: "live", label: "Live" },
              ],
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
