import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

const OAUTH_TOKEN_URL = "https://www.reddit.com/api/v1/access_token";

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
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: ["identity", "read"],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          accessToken: "REDDIT_ACCESS_TOKEN",
          refreshToken: "REDDIT_REFRESH_TOKEN",
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
