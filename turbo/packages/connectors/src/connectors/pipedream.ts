import type { ConnectorConfig } from "../connectors";

export const pipedream = {
  pipedream: {
    label: "Pipedream",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Pipedream account to create workflows, manage event sources, and call the Pipedream REST API",
    authMethods: {
      "api-token": {
        label: "User API Key",
        helpText:
          "1. Log in to [Pipedream](https://pipedream.com)\n2. Open **My Account → API Key** in your user settings\n3. Copy your user API key\n4. Pipedream sends this key as `Authorization: Bearer <api key>`",
        storage: {
          secrets: ["PIPEDREAM_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PIPEDREAM_TOKEN: {
              label: "User API Key",
              required: true,
              placeholder: "pd_CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLocal",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PIPEDREAM_TOKEN: "$secrets.PIPEDREAM_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
