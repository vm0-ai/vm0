import type { ConnectorConfig } from "../connectors";

export const mailsac = {
  mailsac: {
    label: "Mailsac",
    category: "communication-collaboration",
    helpText:
      "Connect your Mailsac account to manage disposable email inboxes for testing",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [Mailsac](https://mailsac.com) and sign up for an account\n2. Log in to your Mailsac dashboard\n3. Navigate to [API Keys](https://mailsac.com/api-keys)\n4. Copy your API key from the dashboard",
        grant: {
          kind: "manual",
          fields: {
            MAILSAC_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-mailsac-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MAILSAC_TOKEN: "$secrets.MAILSAC_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
