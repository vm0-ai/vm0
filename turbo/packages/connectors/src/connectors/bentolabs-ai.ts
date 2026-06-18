import type { ConnectorConfig } from "../connectors";

export const bentolabsAi = {
  "bentolabs-ai": {
    label: "BentoLabs AI",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect your BentoLabs AI account to access agent observability APIs and SDKs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your BentoLabs AI account\n2. Follow the [BentoLabs AI API docs](https://docs.bentolabs.ai/llms.txt) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["BENTOLABS_AI_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            BENTOLABS_AI_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-bentolabs-ai-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BENTOLABS_AI_API_KEY: "$secrets.BENTOLABS_AI_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
