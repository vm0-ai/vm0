import type { ConnectorConfig } from "../connectors";

export const pipedream = {
  pipedream: {
    label: "Pipedream",
    category: "data-automation-infrastructure",
    environmentMapping: {
      PIPEDREAM_TOKEN: "$secrets.PIPEDREAM_TOKEN",
    },
    helpText:
      "Connect your Pipedream account to create workflows, manage event sources, and call the Pipedream REST API",
    authMethods: {
      "api-token": {
        label: "User API Key",
        helpText:
          "1. Log in to [Pipedream](https://pipedream.com)\n2. Open **My Account → API Key** in your user settings\n3. Copy your user API key\n4. Pipedream sends this key as `Authorization: Bearer <api key>`",
        secrets: {
          PIPEDREAM_TOKEN: {
            label: "User API Key",
            required: true,
            placeholder: "pd_CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
