import type { ConnectorConfig } from "../connectors";

export const coresignal = {
  coresignal: {
    label: "Coresignal",
    category: "sales-crm-business-operations",
    helpText:
      "Connect Coresignal to search, enrich, and collect company, employee, and jobs data through Coresignal APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Coresignal self-service dashboard](https://dashboard.coresignal.com)\n2. Open **API Keys** from your account settings or homepage\n3. Copy an API key\n4. Use it in requests with the `apikey` header",
        grant: {
          kind: "manual",
          fields: {
            CORESIGNAL_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-coresignal-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            CORESIGNAL_TOKEN: "$secrets.CORESIGNAL_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
