import type { ConnectorConfig } from "../connectors";

export const clado = {
  clado: {
    label: "Clado",
    category: "sales-crm-business-operations",
    helpText:
      "Connect Clado to search and enrich a B2B people graph for prospecting and recruiting",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [Clado](https://clado.ai)\n2. Open the **API keys** page in your account\n3. Click **Create Key**, name it, and copy the value\n4. Use it as a Bearer token on requests to `https://search.clado.ai`",
        grant: {
          kind: "manual",
          fields: {
            CLADO_TOKEN: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            CLADO_TOKEN: "$secrets.CLADO_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
