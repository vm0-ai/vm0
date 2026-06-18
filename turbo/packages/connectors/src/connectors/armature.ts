import type { ConnectorConfig } from "../connectors";

export const armature = {
  armature: {
    label: "Armature",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect your Armature account to access agent session analytics and evaluation APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Armature account\n2. Follow the [Armature API docs](https://armature.tech/docs) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["ARMATURE_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            ARMATURE_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-armature-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ARMATURE_API_KEY: "$secrets.ARMATURE_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
