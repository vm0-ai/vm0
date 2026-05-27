import type { ConnectorConfig } from "../connectors";

export const agentmail = {
  agentmail: {
    label: "AgentMail",
    category: "communication-collaboration",
    helpText:
      "Connect your AgentMail account to create email inboxes for AI agents, send and receive emails, manage threads, drafts, and webhooks",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [AgentMail Console](https://console.agentmail.to)\n2. Go to **API Keys**\n3. Create a new API key\n4. Copy the key",
        grant: {
          kind: "manual",
          fields: {
            AGENTMAIL_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-agentmail-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            AGENTMAIL_TOKEN: "$secrets.AGENTMAIL_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
