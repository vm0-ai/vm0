import type { ConnectorConfig } from "../connectors";

export const granola = {
  granola: {
    label: "Granola",
    category: "meetings-scheduling",
    helpText:
      "Connect your Granola account to access meeting notes, transcripts, summaries, and calendar event details",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Open the [Granola](https://granola.ai) desktop app\n2. Go to **Settings > API**\n3. Click the **Create new key** button\n4. Choose a key type (if prompted) and click **Generate API Key**\n5. Copy and save the API key securely",
        grant: {
          kind: "manual",
          fields: {
            GRANOLA_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-granola-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            GRANOLA_TOKEN: "$secrets.GRANOLA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
