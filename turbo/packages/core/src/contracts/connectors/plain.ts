import type { ConnectorConfig } from "../connectors";

export const plain = {
  plain: {
    label: "Plain",
    environmentMapping: {
      PLAIN_TOKEN: "$secrets.PLAIN_TOKEN",
    },
    helpText:
      "Connect your Plain account to manage customer support threads, customers, and labels via Plain's GraphQL API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Plain](https://app.plain.com)\n2. Go to **Settings → Machine Users**\n3. Click **New machine user** and generate an API key\n4. Copy the API key",
        secrets: {
          PLAIN_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "plainApiKey__...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
