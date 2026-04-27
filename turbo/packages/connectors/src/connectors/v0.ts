import type { ConnectorConfig } from "../connectors";

export const v0 = {
  v0: {
    label: "v0",
    category: "ai-agent-apps",
    environmentMapping: {
      V0_TOKEN: "$secrets.V0_TOKEN",
    },
    helpText:
      "Connect your v0 account to generate UI components, chat completions, and iterate on React and Next.js code with the v0 Platform API",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [v0](https://v0.dev)\n2. Go to **Settings** → **Keys** ([direct link](https://v0.dev/chat/settings/keys))\n3. Create a new API key\n4. Copy the generated token",
        secrets: {
          V0_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "v0-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
