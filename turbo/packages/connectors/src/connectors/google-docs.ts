import type { ConnectorConfig } from "../connectors";

export const googleDocs = {
  "google-docs": {
    label: "Google Docs",
    category: "docs-files-knowledge",
    environmentMapping: {
      GOOGLE_DOCS_TOKEN: "$secrets.GOOGLE_DOCS_ACCESS_TOKEN",
    },
    helpText: "Connect your Google account to access and manage documents",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Docs access.",
        secrets: {
          GOOGLE_DOCS_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_DOCS_REFRESH_TOKEN: {
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
      scopes: [
        "https://www.googleapis.com/auth/documents",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
