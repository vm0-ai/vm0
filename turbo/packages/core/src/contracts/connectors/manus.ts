import type { ConnectorConfig } from "../connectors";

export const manus = {
  manus: {
    label: "Manus",
    environmentMapping: {
      MANUS_TOKEN: "$secrets.MANUS_TOKEN",
    },
    helpText:
      "Connect your Manus account to run AI agent tasks, manage projects, upload files, and automate multi-step workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [Manus](https://manus.im)\n2. Navigate to **Settings → Integration → Build with Manus API**\n3. Click **Create New**, give it a name, and confirm\n4. Copy the generated API key",
        secrets: {
          MANUS_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-manus-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
