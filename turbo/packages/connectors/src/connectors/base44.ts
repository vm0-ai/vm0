import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://app.base44.com/oauth/token";

export const base44 = {
  base44: {
    label: "Base44",
    category: "ai-agent-apps",
    helpText:
      "Connect your Base44 account to let agents access and manage your Base44 apps",
    authMethods: {
      oauth: {
        label: "OAuth",
        helpText: "Sign in with Base44 to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "base44_cli",
        },
        grant: {
          kind: "device-auth",
          deviceAuthUrl: "https://app.base44.com/oauth/device/code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: ["apps:read", "apps:write", "offline"],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          accessToken: "BASE44_ACCESS_TOKEN",
          refreshToken: "BASE44_REFRESH_TOKEN",
          envBindings: {
            BASE44_TOKEN: "$secrets.BASE44_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
