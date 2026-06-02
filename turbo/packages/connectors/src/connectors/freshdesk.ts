import type { ConnectorConfig } from "../connectors";

export const freshdesk = {
  freshdesk: {
    label: "Freshdesk",
    category: "communication-collaboration",
    tags: ["helpdesk", "tickets", "customer-support"],
    helpText:
      "Connect your Freshdesk account to manage support tickets, contacts, companies, agents, and knowledge base articles",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to Freshdesk and click your profile picture (top right), then **Profile Settings**\n2. On the right pane, click **View API Key** and complete the captcha\n3. Copy the API key\n4. Enter your Freshdesk subdomain — the prefix of `https://<subdomain>.freshdesk.com`",
        storage: {
          secrets: ["FRESHDESK_TOKEN"],
          variables: ["FRESHDESK_DOMAIN"],
        },
        grant: {
          kind: "manual",
          fields: {
            FRESHDESK_TOKEN: {
              label: "API Key",
              required: true,
            },
            FRESHDESK_DOMAIN: {
              label: "Subdomain",
              required: true,
              storage: "variable",
              placeholder: "your-subdomain",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            FRESHDESK_TOKEN: "$secrets.FRESHDESK_TOKEN",
            FRESHDESK_DOMAIN: "$vars.FRESHDESK_DOMAIN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
