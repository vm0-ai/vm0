import type { ConnectorConfig } from "../connectors";

export const freshdesk = {
  freshdesk: {
    label: "Freshdesk",
    category: "communication-collaboration",
    tags: ["helpdesk", "tickets", "customer-support"],
    environmentMapping: {
      FRESHDESK_TOKEN: "$secrets.FRESHDESK_TOKEN",
      FRESHDESK_DOMAIN: "$vars.FRESHDESK_DOMAIN",
    },
    helpText:
      "Connect your Freshdesk account to manage support tickets, contacts, companies, agents, and knowledge base articles",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to Freshdesk and click your profile picture (top right), then **Profile Settings**\n2. On the right pane, click **View API Key** and complete the captcha\n3. Copy the API key\n4. Enter your Freshdesk subdomain — the prefix of `https://<subdomain>.freshdesk.com`",
        secrets: {
          FRESHDESK_TOKEN: {
            label: "API Key",
            required: true,
          },
          FRESHDESK_DOMAIN: {
            label: "Subdomain",
            required: true,
            type: "variable",
            placeholder: "your-subdomain",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
