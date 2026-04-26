import { FeatureSwitchKey } from "../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const mercury = {
  mercury: {
    label: "Mercury",
    category: "sales-crm-business-operations",
    environmentMapping: {
      MERCURY_TOKEN: "$secrets.MERCURY_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.MercuryConnector,
    helpText:
      "Connect your Mercury account to access banking and financial data",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Mercury to grant access.",
        secrets: {
          MERCURY_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          MERCURY_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your [Mercury Dashboard](https://mercury.com)\n2. Go to **Settings → Tokens**\n3. Generate a new API token\n4. Copy the token",
        secrets: {
          MERCURY_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "secret-token:mercury_production_...",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://oauth2.mercury.com/oauth2/auth",
      tokenUrl: "https://oauth2.mercury.com/oauth2/token",
      scopes: ["offline_access"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
