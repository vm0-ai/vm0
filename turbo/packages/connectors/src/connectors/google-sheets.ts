import type { ConnectorConfig } from "../connectors";

export const googleSheets = {
  "google-sheets": {
    label: "Google Sheets",
    category: "docs-files-knowledge",
    helpText: "Connect your Google account to access and manage spreadsheets",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Sheets access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: "https://oauth2.googleapis.com/token",
          scopes: [
            "https://www.googleapis.com/auth/spreadsheets",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
        },
        access: {
          kind: "refresh-token",
          accessToken: "GOOGLE_SHEETS_ACCESS_TOKEN",
          refreshToken: "GOOGLE_SHEETS_REFRESH_TOKEN",
          envBindings: {
            GOOGLE_SHEETS_TOKEN: "$secrets.GOOGLE_SHEETS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
