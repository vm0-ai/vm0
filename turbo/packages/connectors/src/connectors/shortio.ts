import type { ConnectorConfig } from "../connectors";

export const shortio = {
  shortio: {
    label: "Short.io",
    category: "marketing-content-growth",
    helpText:
      "Connect your Short.io account to create and manage short links and track click analytics",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Short.io](https://short.io) Dashboard\n2. Navigate to **Integrations and API**\n3. Click on **Create API key**\n4. Leave the **Public key** option disabled to create a private (secret) key\n5. Restrict the scope of the key to a specific team or domain\n6. Click **Create**\n7. Copy the key and store it in a safe place — secret keys cannot be recovered",
        grant: {
          kind: "manual",
          fields: {
            SHORTIO_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-shortio-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            SHORTIO_TOKEN: "$secrets.SHORTIO_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
