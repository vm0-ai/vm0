import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const dropbox = {
  dropbox: {
    label: "Dropbox",
    category: "docs-files-knowledge",
    environmentMapping: {
      DROPBOX_TOKEN: "$secrets.DROPBOX_ACCESS_TOKEN",
    },
    helpText: "Connect your Dropbox account to access and manage files",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.DropboxConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Dropbox to grant access.",
        secrets: {
          DROPBOX_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          DROPBOX_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps)\n2. Select your app (or create a new one)\n3. Click the button to generate an access token for your own account\n4. Copy the generated OAuth 2 access token",
        secrets: {
          DROPBOX_TOKEN: {
            label: "Access Token",
            required: true,
            placeholder: "sl.xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
      tokenUrl: "https://api.dropboxapi.com/oauth2/token",
      scopes: [
        "account_info.read",
        "files.metadata.read",
        "files.content.read",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
