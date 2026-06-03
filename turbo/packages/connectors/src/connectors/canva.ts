import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const canva = {
  canva: {
    label: "Canva",
    category: "docs-files-knowledge",
    helpText:
      "Connect your Canva account to access designs, assets, and projects",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.CanvaConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Canva to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "CANVA_OAUTH_CLIENT_ID",
          clientSecretEnv: "CANVA_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["CANVA_ACCESS_TOKEN", "CANVA_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
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
          outputs: {
            accessToken: "$secrets.CANVA_ACCESS_TOKEN",
            refreshToken: "$secrets.CANVA_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.CANVA_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.CANVA_ACCESS_TOKEN",
            refreshToken: "$secrets.CANVA_REFRESH_TOKEN",
          },
          refreshableSecrets: ["CANVA_ACCESS_TOKEN"],
          envBindings: {
            CANVA_TOKEN: "$secrets.CANVA_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
