import type { ConnectorConfig } from "../connectors";

export const parallel = {
  parallel: {
    label: "Parallel",
    category: "ai-agent-apps",
    helpText:
      "Connect Parallel to use its web search, extraction, task, FindAll, and monitor APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [Parallel Platform](https://platform.parallel.ai)\n2. Create or copy your API key\n3. Use it as `PARALLEL_API_KEY`",
        grant: {
          kind: "manual",
          fields: {
            PARALLEL_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-parallel-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PARALLEL_API_KEY: "$secrets.PARALLEL_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
