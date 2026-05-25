import type { ConnectorConfig } from "../connectors";

export const honcho = {
  honcho: {
    label: "Honcho",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect Honcho to add persistent memory, context, and stateful reasoning to agents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Honcho](https://app.honcho.dev)\n2. Open **API KEYS**\n3. Create or copy an API key\n4. Honcho sends this key as `Authorization: Bearer <token>`",
        grant: {
          kind: "manual",
          fields: {
            HONCHO_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "hch-v3-CoffeeSafeLocalCoffeeSafeLocalCoffeeSafe",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            HONCHO_API_KEY: "$secrets.HONCHO_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
