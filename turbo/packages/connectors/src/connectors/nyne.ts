import type { ConnectorConfig } from "../connectors";

export const nyne = {
  nyne: {
    label: "Nyne",
    category: "sales-crm-business-operations",
    environmentMapping: {
      NYNE_API_KEY: "$secrets.NYNE_API_KEY",
      NYNE_API_SECRET: "$secrets.NYNE_API_SECRET",
    },
    helpText:
      "Connect Nyne to orchestrate AI sales agents that prospect, qualify, and book meetings",
    authMethods: {
      "api-token": {
        label: "API Credentials",
        helpText:
          "1. Sign in at [nyne.ai](https://nyne.ai)\n2. Open your dashboard → **API Keys**\n3. Copy your **API Key** and **API Secret**\n4. Nyne authenticates each request with both `X-API-Key` and `X-API-Secret` headers on `https://api.nyne.ai`",
        secrets: {
          NYNE_API_KEY: {
            label: "API Key",
            required: true,
          },
          NYNE_API_SECRET: {
            label: "API Secret",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
