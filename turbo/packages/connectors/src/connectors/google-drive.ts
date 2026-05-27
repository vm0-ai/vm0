import type { ConnectorConfig } from "../connectors";

export const googleDrive = {
  "google-drive": {
    label: "Google Drive",
    category: "docs-files-knowledge",
    helpText: "Connect your Google account to access and manage files in Drive",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Drive access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://oauth2.googleapis.com/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
            clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
          },
          scopes: [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
        },
        access: {
          kind: "refresh-token",
          accessToken: "GOOGLE_DRIVE_ACCESS_TOKEN",
          refreshToken: "GOOGLE_DRIVE_REFRESH_TOKEN",
          envBindings: {
            GOOGLE_DRIVE_TOKEN: "$secrets.GOOGLE_DRIVE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
