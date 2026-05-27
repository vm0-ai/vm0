import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const ahrefs = {
  ahrefs: {
    label: "Ahrefs",
    category: "marketing-content-growth",
    helpText:
      "Connect your Ahrefs account to access SEO data, backlink analysis, and keyword research",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.AhrefsConnector,
        label: "OAuth",
        helpText: "Sign in with Ahrefs to grant access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://app.ahrefs.com/api/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "AHREFS_OAUTH_CLIENT_ID",
            clientSecretEnv: "AHREFS_OAUTH_CLIENT_SECRET",
          },
          scopes: ["api"],
        },
        access: {
          kind: "refresh-token",
          accessToken: "AHREFS_ACCESS_TOKEN",
          refreshToken: "AHREFS_REFRESH_TOKEN",
          envBindings: {
            AHREFS_TOKEN: "$secrets.AHREFS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Ahrefs](https://ahrefs.com) as a workspace owner or admin\n2. Go to **Account settings > API keys**\n3. Create a new API key\n4. Copy the API key and use it in the `Authorization: Bearer <YOUR_API_KEY>` header",
        grant: {
          kind: "manual",
          fields: {
            AHREFS_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "your-ahrefs-api-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            AHREFS_TOKEN: "$secrets.AHREFS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
