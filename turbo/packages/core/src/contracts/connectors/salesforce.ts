import type { ConnectorConfig } from "../connectors";

export const salesforce = {
  salesforce: {
    label: "Salesforce",
    environmentMapping: {
      SALESFORCE_TOKEN: "$secrets.SALESFORCE_TOKEN",
      SALESFORCE_INSTANCE: "$vars.SALESFORCE_INSTANCE",
    },
    helpText:
      "Connect your Salesforce account to manage CRM data, contacts, leads, and sales workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          SALESFORCE_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "00D...",
          },
          SALESFORCE_INSTANCE: {
            label: "Instance",
            required: true,
            placeholder: "mycompany",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
