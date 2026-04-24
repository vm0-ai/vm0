import type { ConnectorConfig } from "../connectors";

export const hubspot = {
  hubspot: {
    label: "HubSpot",
    category: "sales-crm-business-operations",
    environmentMapping: {
      HUBSPOT_TOKEN: "$secrets.HUBSPOT_ACCESS_TOKEN",
    },
    helpText:
      "Connect your HubSpot account to manage contacts, companies, deals, and tickets",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with HubSpot to grant access.",
        secrets: {
          HUBSPOT_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          HUBSPOT_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://app.hubspot.com/oauth/authorize",
      tokenUrl: "https://api.hubapi.com/oauth/v1/token",
      scopes: [
        "crm.objects.contacts.read",
        "crm.objects.contacts.write",
        "crm.objects.companies.read",
        "crm.objects.companies.write",
        "crm.objects.deals.read",
        "crm.objects.deals.write",
        "tickets",
        "crm.objects.line_items.read",
        "crm.objects.quotes.read",
        "crm.lists.read",
        "crm.schemas.contacts.read",
        "settings.users.read",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
