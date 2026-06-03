import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const dropbox = {
  dropbox: {
    label: "Dropbox",
    category: "docs-files-knowledge",
    helpText: "Connect your Dropbox account to access and manage files",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.DropboxConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Dropbox to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "DROPBOX_OAUTH_CLIENT_ID",
          clientSecretEnv: "DROPBOX_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["DROPBOX_ACCESS_TOKEN", "DROPBOX_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "DROPBOX_ACCESS_TOKEN",
            refreshToken: "DROPBOX_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "account_info.read",
            "files.metadata.read",
            "files.content.read",
          ],
        },
        access: {
          kind: "refresh-token",
          envBindings: {
            DROPBOX_TOKEN: "$secrets.DROPBOX_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Go to the [Dropbox App Console](https://www.dropbox.com/developers/apps)\n2. Select your app (or create a new one)\n3. Click the button to generate an access token for your own account\n4. Copy the generated OAuth 2 access token",
        storage: {
          secrets: ["DROPBOX_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            DROPBOX_TOKEN: {
              label: "Access Token",
              required: true,
              placeholder: "sl.xxxxxxxx",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DROPBOX_TOKEN: "$secrets.DROPBOX_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
