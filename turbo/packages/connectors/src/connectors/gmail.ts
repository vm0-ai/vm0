import type { ConnectorConfig } from "../connectors";

export const gmail = {
  gmail: {
    label: "Gmail",
    category: "communication-collaboration",
    tags: ["email", "mail"],
    environmentMapping: {
      GMAIL_TOKEN: "$secrets.GMAIL_ACCESS_TOKEN",
    },
    helpText: "Connect your Gmail account to send and read emails",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Gmail access.",
        secrets: {
          GMAIL_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GMAIL_REFRESH_TOKEN: {
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
      scopes: ["https://www.googleapis.com/auth/gmail.modify"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
