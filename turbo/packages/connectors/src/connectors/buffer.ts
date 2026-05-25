import type { ConnectorConfig } from "../connectors";

export const buffer = {
  buffer: {
    label: "Buffer",
    category: "marketing-content-growth",
    helpText:
      "Connect your Buffer account to schedule, draft, and publish social media posts across your connected channels (Twitter/X, LinkedIn, Instagram, Facebook, TikTok, Threads, Bluesky, Mastodon, Pinterest, YouTube). **Note: Buffer's API is currently in beta.**",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Buffer](https://publish.buffer.com) and go to **Settings > Developer Dashboard** (you must be an **Org Owner** — paid accounts can create up to 5 keys; free accounts get 1).\n2. Click **Create API Key**, give it a name, and set an expiration if desired.\n3. Copy the key immediately — it's only shown once.\n4. Paste it here.\n\n**Note:** Buffer's API is currently in beta.",
        grant: {
          kind: "manual",
          fields: {
            BUFFER_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "Buffer personal API key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            BUFFER_TOKEN: "$secrets.BUFFER_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
