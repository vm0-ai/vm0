import type { ConnectorConfig } from "../connectors";

export const zendesk = {
  zendesk: {
    label: "Zendesk",
    category: "communication-collaboration",
    helpText:
      "Connect your Zendesk account to manage support tickets, users, organizations, and automate customer support workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Zendesk Admin Center](https://www.zendesk.com/admin/)\n2. Go to **Apps and integrations → APIs → Zendesk API**\n3. Enable **Token Access** under the Settings tab\n4. Click **Add API token** and copy the token",
        grant: {
          kind: "manual",
          fields: {
            ZENDESK_API_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "your-zendesk-api-token",
            },
            ZENDESK_EMAIL: {
              label: "Email",
              required: true,
              placeholder: "your-email@company.com",
              storage: "variable",
            },
            ZENDESK_SUBDOMAIN: {
              label: "Subdomain",
              required: true,
              placeholder: "yourcompany",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            ZENDESK_API_TOKEN: "$secrets.ZENDESK_API_TOKEN",
            ZENDESK_EMAIL: "$vars.ZENDESK_EMAIL",
            ZENDESK_SUBDOMAIN: "$vars.ZENDESK_SUBDOMAIN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
