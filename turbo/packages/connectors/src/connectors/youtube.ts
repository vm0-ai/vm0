import type { ConnectorConfig } from "../connectors";

export const youtube = {
  youtube: {
    label: "YouTube",
    category: "marketing-content-growth",
    helpText:
      "Connect your YouTube account to search videos, get channel info, and fetch comments via the Data API",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant YouTube Data API access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["YOUTUBE_ACCESS_TOKEN", "YOUTUBE_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/youtube",
            "https://www.googleapis.com/auth/youtube.force-ssl",
            "https://www.googleapis.com/auth/youtube.readonly",
            "https://www.googleapis.com/auth/youtube.upload",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.YOUTUBE_ACCESS_TOKEN",
            refreshToken: "$secrets.YOUTUBE_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.YOUTUBE_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.YOUTUBE_ACCESS_TOKEN",
            refreshToken: "$secrets.YOUTUBE_REFRESH_TOKEN",
          },
          refreshableSecrets: ["YOUTUBE_ACCESS_TOKEN"],
          envBindings: {
            YOUTUBE_TOKEN: "$secrets.YOUTUBE_ACCESS_TOKEN",
          },
        },
        revoke: {
          kind: "token-revoke",
          inputs: {
            refreshToken: "$secrets.YOUTUBE_REFRESH_TOKEN",
          },
        },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
