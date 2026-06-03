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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["GOOGLE_DRIVE_ACCESS_TOKEN", "GOOGLE_DRIVE_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/drive",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_DRIVE_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_DRIVE_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_DRIVE_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_DRIVE_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_DRIVE_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_DRIVE_ACCESS_TOKEN"],
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
