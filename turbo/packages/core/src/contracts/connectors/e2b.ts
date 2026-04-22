import type { ConnectorConfig } from "../connectors";

export const e2b = {
  e2b: {
    label: "E2B",
    environmentMapping: {
      E2B_TOKEN: "$secrets.E2B_TOKEN",
    },
    helpText:
      "Connect your E2B account to create and manage secure cloud sandboxes for AI code execution",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up at [e2b.dev](https://e2b.dev)\n2. Go to Dashboard → **API Keys**\n3. Click **Create API Key**\n4. Copy the key (starts with `e2b_`). Paste it here.",
        secrets: {
          E2B_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "e2b_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
