import type { ConnectorConfig } from "../connectors";

export const googleSheets = {
  "google-sheets": {
    label: "Google Sheets",
    category: "docs-files-knowledge",
    environmentMapping: {
      GOOGLE_SHEETS_TOKEN: "$secrets.GOOGLE_SHEETS_ACCESS_TOKEN",
    },
    helpText: "Connect your Google account to access and manage spreadsheets",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Sheets access.",
        secrets: {
          GOOGLE_SHEETS_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_SHEETS_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      flow: "authorization-code",
      tokenUrl: "https://oauth2.googleapis.com/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      scopes: [
        "https://www.googleapis.com/auth/spreadsheets",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
