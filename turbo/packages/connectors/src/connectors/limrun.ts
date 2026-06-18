import type { ConnectorConfig } from "../connectors";

export const limrun = {
  limrun: {
    label: "Limrun",
    category: "engineering-team-execution",
    helpText:
      "Connect your Limrun account to access remote mobile build and simulator APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Limrun account\n2. Follow the [Limrun API docs](https://docs.limrun.com/docs) to create or copy an API key\n3. Paste the key here.",
        storage: {
          secrets: ["LIMRUN_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            LIMRUN_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-limrun-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            LIMRUN_API_KEY: "$secrets.LIMRUN_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
