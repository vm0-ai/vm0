import type { ConnectorConfig } from "../connectors";

export const interfaze = {
  interfaze: {
    label: "Interfaze",
    category: "ai-general-models",
    helpText:
      "Connect your Interfaze account to access deterministic AI model APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Interfaze account\n2. Follow the [Interfaze API docs](https://interfaze.ai/docs) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["INTERFAZE_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            INTERFAZE_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-interfaze-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            INTERFAZE_API_KEY: "$secrets.INTERFAZE_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
