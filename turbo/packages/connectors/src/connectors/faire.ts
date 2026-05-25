import type { ConnectorConfig } from "../connectors";

export const faire = {
  faire: {
    label: "Faire",
    category: "sales-crm-business-operations",
    tags: [
      "wholesale",
      "marketplace",
      "brands",
      "orders",
      "inventory",
      "products",
    ],
    helpText:
      "Connect your Faire brand account to manage wholesale products, orders, inventory, shipments, and brand profile data",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. In the Faire portal, go to **Settings > Integrations**\n2. Generate an API key for a direct integration, or request one from Faire for a custom integration\n3. Copy the access token for the brand account you want to connect",
        grant: {
          kind: "manual",
          fields: {
            FAIRE_TOKEN: {
              label: "Access Token",
              required: true,
              placeholder: "your-faire-access-token",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            FAIRE_TOKEN: "$secrets.FAIRE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
