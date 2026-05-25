import type { ConnectorConfig } from "../connectors";

export const productlane = {
  productlane: {
    label: "Productlane",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Productlane account to manage feedback, insights, changelogs, and customer data",
    authMethods: {
      "api-token": {
        label: "API Key",
        grant: {
          kind: "manual",
          fields: {
            PRODUCTLANE_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-productlane-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            PRODUCTLANE_TOKEN: "$secrets.PRODUCTLANE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
