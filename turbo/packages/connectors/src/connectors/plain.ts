import type { ConnectorConfig } from "../connectors";

export const plain = {
  plain: {
    label: "Plain",
    category: "communication-collaboration",
    helpText:
      "Connect your Plain account to manage customer support threads, customers, and labels via Plain's GraphQL API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Plain](https://app.plain.com)\n2. Go to **Settings → Machine Users**\n3. Click **New machine user** and generate an API key\n4. Copy the API key",
        storage: {
          secrets: ["PLAIN_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            PLAIN_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "plainApiKey__...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PLAIN_TOKEN: "$secrets.PLAIN_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
