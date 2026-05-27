import type { ConnectorConfig } from "../connectors";

export const youtube = {
  youtube: {
    label: "YouTube",
    category: "marketing-content-growth",
    helpText:
      "Connect your YouTube account to search videos, get channel info, and fetch comments via the Data API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [Google Cloud Console](https://console.cloud.google.com/)\n2. Enable **YouTube Data API v3**\n3. Go to **Credentials** → **Create Credentials** → **API Key**\n4. Copy the API key",
        grant: {
          kind: "manual",
          fields: {
            YOUTUBE_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "AIzaSy...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            YOUTUBE_TOKEN: "$secrets.YOUTUBE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
