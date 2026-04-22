import type { ConnectorConfig } from "../connectors";

export const productlane = {
  productlane: {
    label: "Productlane",
    environmentMapping: {
      PRODUCTLANE_TOKEN: "$secrets.PRODUCTLANE_TOKEN",
    },
    helpText:
      "Connect your Productlane account to manage feedback, insights, changelogs, and customer data",
    authMethods: {
      "api-token": {
        label: "API Key",
        secrets: {
          PRODUCTLANE_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-productlane-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
