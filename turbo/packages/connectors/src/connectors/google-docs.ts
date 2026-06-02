import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://oauth2.googleapis.com/token";

export const googleDocs = {
  "google-docs": {
    label: "Google Docs",
    category: "docs-files-knowledge",
    helpText: "Connect your Google account to access and manage documents",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Docs access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "https://www.googleapis.com/auth/documents",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
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
