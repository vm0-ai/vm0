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
        showExperimentalLabel: false,
        label: "Sign in with Stripe",
        helpText: "Sign in with Stripe to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "STRIPE_OAUTH_CLIENT_ID",
          clientSecretEnv: "STRIPE_SECRET_KEY",
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
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
