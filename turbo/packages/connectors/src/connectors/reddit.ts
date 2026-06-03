import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const reddit = {
  reddit: {
    label: "Reddit",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Reddit account to access Reddit discussions and content",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.RedditConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Reddit to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "REDDIT_OAUTH_CLIENT_ID",
          clientSecretEnv: "REDDIT_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["REDDIT_ACCESS_TOKEN", "REDDIT_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "REDDIT_ACCESS_TOKEN",
            refreshToken: "REDDIT_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          scopes: ["identity", "read"],
        },
        access: {
          kind: "refresh-token",
          envBindings: {
            REDDIT_TOKEN: "$secrets.REDDIT_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
