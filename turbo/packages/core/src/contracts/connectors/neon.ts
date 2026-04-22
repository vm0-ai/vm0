import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const neon = {
  neon: {
    label: "Neon",
    environmentMapping: {
      NEON_TOKEN: "$secrets.NEON_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.NeonConnector,
    helpText:
      "Connect your Neon account to manage serverless Postgres databases and projects",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Neon to grant access.",
        secrets: {
          NEON_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          NEON_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Neon Console](https://console.neon.tech)\n2. Navigate to **Account settings > API keys**\n3. Click the button to create a new API key\n4. Copy and store the secret token immediately (it is only displayed once)",
        secrets: {
          NEON_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "napi_xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://oauth2.neon.tech/oauth2/auth",
      tokenUrl: "https://oauth2.neon.tech/oauth2/token",
      scopes: [
        "openid",
        "offline_access",
        "urn:neoncloud:projects:read",
        "urn:neoncloud:projects:create",
        "urn:neoncloud:projects:update",
        "urn:neoncloud:projects:delete",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
