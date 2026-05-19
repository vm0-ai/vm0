import type { ConnectorConfig } from "../connectors";

export const googleDrive = {
  "google-drive": {
    label: "Google Drive",
    category: "docs-files-knowledge",
    environmentMapping: {
      GOOGLE_DRIVE_TOKEN: "$secrets.GOOGLE_DRIVE_ACCESS_TOKEN",
    },
    helpText: "Connect your Google account to access and manage files in Drive",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Drive access.",
        secrets: {
          GOOGLE_DRIVE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_DRIVE_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      scopes: [
        "https://www.googleapis.com/auth/drive",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
