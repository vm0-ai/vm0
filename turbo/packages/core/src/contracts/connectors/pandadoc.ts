import type { ConnectorConfig } from "../connectors";

export const pandadoc = {
  pandadoc: {
    label: "PandaDoc",
    environmentMapping: {
      PANDADOC_TOKEN: "$secrets.PANDADOC_TOKEN",
    },
    helpText:
      "Connect your PandaDoc account to create, send, and manage contracts, proposals, quotes, and e-signature documents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In PandaDoc, go to **Settings > Integrations > API**\n2. Click **Generate Production Key** (requires an API-enabled plan) or **Generate Sandbox Key** for testing\n3. Copy the key and paste it here\n\nNote: Only Org Admins can generate keys. Sandbox keys work for free but signed documents have no legal validity.",
        secrets: {
          PANDADOC_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your PandaDoc API key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
