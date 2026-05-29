import type { ConnectorConfig } from "../connectors";

export const gmail = {
  gmail: {
    label: "Gmail",
    category: "communication-collaboration",
    tags: ["email", "mail"],
    helpText: "Connect your Gmail account to send and read emails",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Gmail access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: "https://oauth2.googleapis.com/token",
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
        },
        access: {
          kind: "refresh-token",
          accessToken: "GMAIL_ACCESS_TOKEN",
          refreshToken: "GMAIL_REFRESH_TOKEN",
          envBindings: {
            GMAIL_TOKEN: "$secrets.GMAIL_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
