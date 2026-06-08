import type { ConnectorConfig } from "../connectors";

export const cursor = {
  cursor: {
    label: "Cursor",
    category: "ai-agent-apps",
    helpText:
      "Connect your Cursor account to launch and manage cloud coding agents via the Cursor Cloud Agents API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in at [cursor.com](https://cursor.com)\n2. Open **Dashboard → API Keys** ([cursor.com/dashboard/api](https://cursor.com/dashboard/api))\n3. Click **Create API Key**\n4. Copy the key (it begins with `key_`). Paste it here.",
        storage: {
          secrets: ["CURSOR_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            CURSOR_TOKEN: {
              label: "API Key",
              required: true,
              placeholder:
                "key_c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe10ca1c0ffee5afe10ca1c0ff",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            CURSOR_TOKEN: "$secrets.CURSOR_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
