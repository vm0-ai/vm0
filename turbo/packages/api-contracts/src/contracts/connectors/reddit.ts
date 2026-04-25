import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const reddit = {
  reddit: {
    label: "Reddit",
    category: "data-automation-infrastructure",
    environmentMapping: {
      REDDIT_TOKEN: "$secrets.REDDIT_ACCESS_TOKEN",
    },
    featureFlag: FeatureSwitchKey.RedditConnector,
    helpText:
      "Connect your Reddit account to access Reddit discussions and content",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Reddit to grant access.",
        secrets: {
          REDDIT_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          REDDIT_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.reddit.com/api/v1/authorize",
      tokenUrl: "https://www.reddit.com/api/v1/access_token",
      scopes: ["identity", "read"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
