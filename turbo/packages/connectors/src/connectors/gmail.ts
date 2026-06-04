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
        storage: {
          secrets: ["GMAIL_ACCESS_TOKEN", "GMAIL_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: ["https://www.googleapis.com/auth/gmail.modify"],
          outputs: {
            accessToken: "$secrets.GMAIL_ACCESS_TOKEN",
            refreshToken: "$secrets.GMAIL_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GMAIL_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GMAIL_ACCESS_TOKEN",
            refreshToken: "$secrets.GMAIL_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GMAIL_ACCESS_TOKEN"],
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
