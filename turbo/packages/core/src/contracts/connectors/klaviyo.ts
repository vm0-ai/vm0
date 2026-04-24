import type { ConnectorConfig } from "../connectors";

export const klaviyo = {
  klaviyo: {
    label: "Klaviyo",
    category: "marketing-content-growth",
    environmentMapping: {
      KLAVIYO_TOKEN: "$secrets.KLAVIYO_TOKEN",
    },
    helpText:
      "Connect your Klaviyo account to manage profiles, lists, events, subscriptions, and campaigns",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Klaviyo](https://www.klaviyo.com/)\n2. Go to **Account > Settings > API keys**\n3. Click **Create Private API Key**\n4. Grant the scopes your workflow needs (e.g. `profiles:write`, `lists:write`, `events:write`, `subscriptions:write`)\n5. Copy the key (format: `pk_...`)",
        secrets: {
          KLAVIYO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "pk_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
