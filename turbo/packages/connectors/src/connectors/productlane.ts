import type { ConnectorConfig } from "../connector-config";

export const productlane = {
  productlane: {
    label: "Productlane",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Productlane account to manage feedback, insights, changelogs, and customer data",
    authMethods: {
      "api-token": {
        label: "API Key",
        storage: {
          secrets: ["PRODUCTLANE_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PRODUCTLANE_TOKEN: {
              label: "API Key",
              publicId: "apiKey",
              required: true,
              placeholder: "your-productlane-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PRODUCTLANE_TOKEN: "$secrets.PRODUCTLANE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
