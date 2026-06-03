import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const mercury = {
  mercury: {
    label: "Mercury",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Mercury account to access banking and financial data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.MercuryConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Mercury to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "MERCURY_OAUTH_CLIENT_ID",
          clientSecretEnv: "MERCURY_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["MERCURY_ACCESS_TOKEN", "MERCURY_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "MERCURY_ACCESS_TOKEN",
            refreshToken: "MERCURY_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          scopes: ["offline_access"],
        },
        access: {
          kind: "refresh-token",
          envBindings: {
            MERCURY_TOKEN: "$secrets.MERCURY_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your [Mercury Dashboard](https://mercury.com)\n2. Go to **Settings → Tokens**\n3. Generate a new API token\n4. Copy the token",
        storage: {
          secrets: ["MERCURY_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MERCURY_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "secret-token:mercury_production_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MERCURY_TOKEN: "$secrets.MERCURY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
