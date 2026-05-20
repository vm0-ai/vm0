import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const base44 = {
  base44: {
    label: "Base44",
    category: "ai-agent-apps",
    environmentMapping: {
      BASE44_TOKEN: "$secrets.BASE44_ACCESS_TOKEN",
    },
    helpText: "Connect Base44 to authorize access to your apps and workspace.",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.Base44Connector,
        label: "OAuth",
        helpText: "Sign in with Base44 to grant access.",
        secrets: {
          BASE44_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          BASE44_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.base44.com/oauth/authorize",
      tokenUrl: "https://app.base44.com/oauth/token",
      client: {
        clientRegistration: "dynamic",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
      },
      scopes: ["apps:read", "apps:write", "offline"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
