import type { ConnectorConfig } from "../connectors";

export const ashby = {
  ashby: {
    label: "Ashby",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Ashby account to read candidates, applications, jobs, openings, job postings, and recruiting projects via the Ashby API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In Ashby, open **Admin** → **Integrations** → **API Keys**\n2. Create or select an API key with the candidate and job access your workflow needs\n3. Copy the raw API key and paste it here.",
        storage: {
          secrets: ["ASHBY_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            ASHBY_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-ashby-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ASHBY_TOKEN: "$secrets.ASHBY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
