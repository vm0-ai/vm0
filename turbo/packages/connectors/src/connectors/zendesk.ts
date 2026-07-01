import type { ConnectorConfig } from "../connector-config";

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
        storage: {
          secrets: ["ZENDESK_API_TOKEN"],
          variables: ["ZENDESK_EMAIL", "ZENDESK_SUBDOMAIN"],
        },
        grant: {
          kind: "manual",
          fields: {
            ZENDESK_API_TOKEN: {
              label: "API Token",
              publicId: "apiToken",
              required: true,
              placeholder: "your-zendesk-api-token",
            },
            ZENDESK_EMAIL: {
              label: "Email",
              publicId: "email",
              required: true,
              placeholder: "your-email@company.com",
              storage: "variable",
            },
            ZENDESK_SUBDOMAIN: {
              label: "Subdomain",
              publicId: "subdomain",
              required: true,
              placeholder: "yourcompany",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ZENDESK_API_TOKEN: "$secrets.ZENDESK_API_TOKEN",
            ZENDESK_EMAIL: "$vars.ZENDESK_EMAIL",
            ZENDESK_SUBDOMAIN: "$vars.ZENDESK_SUBDOMAIN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
