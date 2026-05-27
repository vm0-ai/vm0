import type { ConnectorConfig } from "../connectors";

export const googleDocs = {
  "google-docs": {
    label: "Google Docs",
    category: "docs-files-knowledge",
    helpText: "Connect your Google account to access and manage documents",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Docs access.",
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
            "https://www.googleapis.com/auth/documents",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
        },
        access: {
          kind: "refresh-token",
          accessToken: "GOOGLE_DOCS_ACCESS_TOKEN",
          refreshToken: "GOOGLE_DOCS_REFRESH_TOKEN",
          envBindings: {
            GOOGLE_DOCS_TOKEN: "$secrets.GOOGLE_DOCS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
