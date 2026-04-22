import type { ConnectorConfig } from "../connectors";

export const gamma = {
  gamma: {
    label: "Gamma",
    environmentMapping: {
      GAMMA_TOKEN: "$secrets.GAMMA_TOKEN",
    },
    helpText:
      "Connect your Gamma account to generate presentations, documents, and websites with AI",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Gamma](https://gamma.app)\n2. Go to [API Keys](https://gamma.app/settings/api-keys) (Settings > API Keys)\n3. Click **Create API key**\n4. Copy the key (it is only shown once)",
        secrets: {
          GAMMA_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "sk-gamma-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
