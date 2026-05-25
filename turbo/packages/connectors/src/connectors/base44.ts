import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const base44 = {
  base44: {
    label: "Base44",
    category: "ai-agent-apps",
    helpText:
      "Connect your Base44 account to let agents access and manage your Base44 apps",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.Base44Connector,
        label: "OAuth",
        helpText: "Sign in with Base44 to grant access.",
        grant: {
          kind: "device-auth",
          deviceAuthUrl: "https://app.base44.com/oauth/device/code",
          tokenUrl: "https://app.base44.com/oauth/token",
          client: {
            clientRegistration: "static",
            clientType: "public",
            tokenEndpointAuthMethod: "none",
            clientId: "base44_cli",
          },
          scopes: ["apps:read", "apps:write", "offline"],
        },
        access: {
          kind: "refresh-token",
          accessToken: "BASE44_ACCESS_TOKEN",
          refreshToken: "BASE44_REFRESH_TOKEN",
          outputs: {
            BASE44_TOKEN: "$secrets.BASE44_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
