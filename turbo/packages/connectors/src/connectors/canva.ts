import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const canva = {
  canva: {
    label: "Canva",
    category: "docs-files-knowledge",
    environmentMapping: {
      CANVA_TOKEN: "$secrets.CANVA_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Canva account to access designs, assets, and projects",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.CanvaConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Canva to grant access.",
        secrets: {
          CANVA_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          CANVA_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.canva.com/api/oauth/authorize",
      tokenUrl: "https://api.canva.com/rest/v1/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_basic",
        clientIdEnv: "CANVA_OAUTH_CLIENT_ID",
        clientSecretEnv: "CANVA_OAUTH_CLIENT_SECRET",
      },
      scopes: [
        "asset:read",
        "asset:write",
        "brandtemplate:content:read",
        "brandtemplate:meta:read",
        "comment:read",
        "comment:write",
        "design:content:read",
        "design:content:write",
        "design:meta:read",
        "folder:read",
        "folder:write",
        "profile:read",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
