import type { ConnectorConfig } from "../connectors";

export const wandb = {
  wandb: {
    label: "Weights & Biases",
    helpText:
      "Connect to Weights & Biases for ML experiment tracking and LLM observability.",
    environmentMapping: { WANDB_TOKEN: "$secrets.WANDB_TOKEN" },
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText: "Go to wandb.ai → Settings → API Keys → copy your key.",
        secrets: {
          WANDB_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "Your W&B API Key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
