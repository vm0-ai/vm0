import type { ConnectorConfig } from "../connectors";

export const hunter = {
  hunter: {
    label: "Hunter",
    category: "sales-crm-business-operations",
    helpText:
      "Connect Hunter to find and verify professional email addresses for outbound and prospecting",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Hunter](https://hunter.io/api-keys)\n2. Open the **API keys** page under your account\n3. Copy your existing key or click **Generate a new key**\n4. Pass it as the `api_key` query parameter on every request",
        grant: {
          kind: "manual",
          fields: {
            HUNTER_TOKEN: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            HUNTER_TOKEN: "$secrets.HUNTER_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
