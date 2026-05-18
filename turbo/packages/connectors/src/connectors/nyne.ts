import type { ConnectorConfig } from "../connectors";

export const nyne = {
  nyne: {
    label: "Nyne",
    category: "sales-crm-business-operations",
    environmentMapping: {
      NYNE_TOKEN: "$secrets.NYNE_TOKEN",
    },
    helpText:
      "Connect Nyne to orchestrate AI sales agents that prospect, qualify, and book meetings",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [Nyne](https://nyne.ai)\n2. Open the **API keys** page in your workspace settings\n3. Click **Create Key**, name it, and copy the value\n4. Use it as a Bearer token on requests to `https://api.nyne.ai`",
        secrets: {
          NYNE_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
