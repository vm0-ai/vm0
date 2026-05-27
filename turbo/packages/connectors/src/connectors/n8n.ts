import type { ConnectorConfig } from "../connectors";

export const n8n = {
  n8n: {
    label: "n8n",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your n8n instance to manage workflows, trigger executions, and automate processes",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Open your n8n instance\n2. Go to **Settings** → **n8n API**\n3. Click **Create an API key**\n4. Copy the key and paste it below\n5. Set your instance URL (e.g. `https://your-instance.app.n8n.cloud`)",
        grant: {
          kind: "manual",
          fields: {
            N8N_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "n8n_api_CoffeeSafeLocalCoffeeSafeLocalCo",
            },
            N8N_BASE_URL: {
              label: "Instance URL",
              required: true,
              storage: "variable",
              placeholder: "https://your-instance.app.n8n.cloud",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            N8N_TOKEN: "$secrets.N8N_TOKEN",
            N8N_BASE_URL: "$vars.N8N_BASE_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
