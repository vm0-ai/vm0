import type { ConnectorConfig } from "../connectors";

export const perplexity = {
  perplexity: {
    label: "Perplexity",
    category: "data-automation-infrastructure",
    environmentMapping: {
      PERPLEXITY_TOKEN: "$secrets.PERPLEXITY_TOKEN",
    },
    helpText:
      "Connect your Perplexity account to access AI-powered search and research capabilities via the Sonar API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          '1. Log in to the [Perplexity Console](https://console.perplexity.ai)\n2. Navigate to the **API Groups** page and create an API group (e.g., "Production" or "Development")\n3. Go to the **API Keys** page\n4. Generate a new API key\n5. Store the key immediately and securely (you will only see the full token value once)',
        secrets: {
          PERPLEXITY_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "pplx-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
