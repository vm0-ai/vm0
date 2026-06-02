import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

const OAUTH_TOKEN_URL = "https://oauth2.neon.tech/oauth2/token";

export const neon = {
  neon: {
    label: "Neon",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Neon account to manage serverless Postgres databases and projects",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.NeonConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Neon to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "NEON_OAUTH_CLIENT_ID",
          clientSecretEnv: "NEON_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["NEON_ACCESS_TOKEN", "NEON_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "NEON_ACCESS_TOKEN",
            refreshToken: "NEON_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "openid",
            "offline_access",
            "urn:neoncloud:projects:read",
            "urn:neoncloud:projects:create",
            "urn:neoncloud:projects:update",
            "urn:neoncloud:projects:delete",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          envBindings: {
            NEON_TOKEN: "$secrets.NEON_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Neon Console](https://console.neon.tech)\n2. Navigate to **Account settings > API keys**\n3. Click the button to create a new API key\n4. Copy and store the secret token immediately (it is only displayed once)",
        storage: {
          secrets: ["NEON_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            NEON_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "napi_xxxxxxxx",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            NEON_TOKEN: "$secrets.NEON_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
