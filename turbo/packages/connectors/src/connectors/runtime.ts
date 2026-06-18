import type { ConnectorConfig } from "../connectors";

export const runtime = {
  runtime: {
    label: "Runtime",
    category: "ai-agent-apps",
    helpText:
      "Connect your Runtime account to access agent runtime and sandbox APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Runtime account\n2. Follow the [Runtime API docs](https://docs.runtm.com/introduction) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["RUNTIME_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            RUNTIME_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-runtime-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            RUNTIME_API_KEY: "$secrets.RUNTIME_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
