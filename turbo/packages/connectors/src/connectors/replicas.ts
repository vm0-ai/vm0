import type { ConnectorConfig } from "../connectors";

export const replicas = {
  replicas: {
    label: "Replicas",
    category: "engineering-team-execution",
    helpText: "Connect your Replicas account to access cloud coding-agent APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Replicas account\n2. Follow the [Replicas API docs](https://docs.tryreplicas.com) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["REPLICAS_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            REPLICAS_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-replicas-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            REPLICAS_API_KEY: "$secrets.REPLICAS_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
