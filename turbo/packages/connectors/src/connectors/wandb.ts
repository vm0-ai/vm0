import type { ConnectorConfig } from "../connectors";

export const wandb = {
  wandb: {
    label: "Weights & Biases",
    category: "ai-memory-tracing-eval",
    helpText:
      "Connect to Weights & Biases for ML experiment tracking and LLM observability.",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText: "Go to wandb.ai → Settings → API Keys → copy your key.",
        storage: {
          secrets: ["WANDB_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            WANDB_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "Your W&B API Key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            WANDB_TOKEN: "$secrets.WANDB_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
