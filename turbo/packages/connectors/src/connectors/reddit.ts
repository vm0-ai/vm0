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
        grant: {
          kind: "auth-code",
          tokenUrl: "https://www.reddit.com/api/v1/access_token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            tokenEndpointAuthMethod: "client_secret_basic",
            clientIdEnv: "REDDIT_OAUTH_CLIENT_ID",
            clientSecretEnv: "REDDIT_OAUTH_CLIENT_SECRET",
          },
          scopes: ["identity", "read"],
        },
        access: {
          kind: "refresh-token",
          accessToken: "REDDIT_ACCESS_TOKEN",
          refreshToken: "REDDIT_REFRESH_TOKEN",
          outputs: {
            REDDIT_TOKEN: "$secrets.REDDIT_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
