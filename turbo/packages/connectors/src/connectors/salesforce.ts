import type { ConnectorConfig } from "../connectors";

export const salesforce = {
  salesforce: {
    label: "Salesforce",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Salesforce account to manage CRM data, contacts, leads, and sales workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        storage: {
          secrets: ["SALESFORCE_TOKEN"],
          variables: ["SALESFORCE_INSTANCE"],
        },
        grant: {
          kind: "manual",
          fields: {
            SALESFORCE_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "00D...",
            },
            SALESFORCE_INSTANCE: {
              label: "Instance",
              required: true,
              placeholder: "mycompany",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SALESFORCE_TOKEN: "$secrets.SALESFORCE_TOKEN",
            SALESFORCE_INSTANCE: "$vars.SALESFORCE_INSTANCE",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
