import type { ConnectorConfig } from "../connectors";

export const hubspot = {
  hubspot: {
    label: "HubSpot",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your HubSpot account to manage contacts, companies, deals, and tickets",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with HubSpot to grant access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://api.hubapi.com/oauth/v1/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            tokenEndpointAuthMethod: "client_secret_post",
            clientIdEnv: "HUBSPOT_OAUTH_CLIENT_ID",
            clientSecretEnv: "HUBSPOT_OAUTH_CLIENT_SECRET",
          },
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
        access: {
          kind: "refresh-token",
          accessToken: "HUBSPOT_ACCESS_TOKEN",
          refreshToken: "HUBSPOT_REFRESH_TOKEN",
          outputs: {
            HUBSPOT_TOKEN: "$secrets.HUBSPOT_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
