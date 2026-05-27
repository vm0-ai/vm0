import type { ConnectorConfig } from "../connectors";

export const manus = {
  manus: {
    label: "Manus",
    category: "ai-agent-apps",
    helpText:
      "Connect your Manus account to run AI agent tasks, manage projects, upload files, and automate multi-step workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to [Manus](https://manus.im)\n2. Navigate to **Settings → Integration → Build with Manus API**\n3. Click **Create New**, give it a name, and confirm\n4. Copy the generated API key",
        grant: {
          kind: "manual",
          fields: {
            MANUS_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-manus-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MANUS_TOKEN: "$secrets.MANUS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
