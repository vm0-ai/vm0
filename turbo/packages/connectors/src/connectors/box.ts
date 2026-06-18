import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const box = {
  box: {
    label: "Box",
    category: "docs-files-knowledge",
    helpText: "Connect your Box account to access and manage files and folders",
    tags: ["files", "storage", "documents"],
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.BoxConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Box to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "BOX_OAUTH_CLIENT_ID",
          clientSecretEnv: "BOX_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["BOX_ACCESS_TOKEN", "BOX_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: ["root_readwrite"],
          outputs: {
            accessToken: "$secrets.BOX_ACCESS_TOKEN",
            refreshToken: "$secrets.BOX_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.BOX_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.BOX_ACCESS_TOKEN",
            refreshToken: "$secrets.BOX_REFRESH_TOKEN",
          },
          refreshableSecrets: ["BOX_ACCESS_TOKEN"],
          envBindings: {
            BOX_TOKEN: "$secrets.BOX_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
