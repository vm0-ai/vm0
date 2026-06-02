import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://api.hubapi.com/oauth/v1/token";

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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "HUBSPOT_OAUTH_CLIENT_ID",
          clientSecretEnv: "HUBSPOT_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["HUBSPOT_ACCESS_TOKEN", "HUBSPOT_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "HUBSPOT_ACCESS_TOKEN",
            refreshToken: "HUBSPOT_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
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
          tokenUrl: OAUTH_TOKEN_URL,
          envBindings: {
            HUBSPOT_TOKEN: "$secrets.HUBSPOT_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
