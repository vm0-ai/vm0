import type { ConnectorConfig } from "../connectors";

export const fireflies = {
  fireflies: {
    label: "Fireflies",
    category: "meetings-scheduling",
    environmentMapping: {
      FIREFLIES_TOKEN: "$secrets.FIREFLIES_TOKEN",
    },
    helpText:
      "Connect your Fireflies.ai account to transcribe and analyze meetings",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Fireflies](https://fireflies.ai)\n2. Navigate to the **Integrations** section\n3. Click on **Fireflies API**\n4. Copy your API key and store it securely",
        secrets: {
          FIREFLIES_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
