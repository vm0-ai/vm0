import type { ConnectorConfig } from "../connectors";

export const huggingFace = {
  "hugging-face": {
    label: "Hugging Face",
    category: "ai-general-models",
    generation: ["image", "text"],
    helpText:
      "Connect your Hugging Face account to access models, datasets, and inference APIs",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Hugging Face](https://huggingface.co)\n2. Go to **Settings → Access Tokens**\n3. Create a new token with the required permissions\n4. Copy the token",
        storage: {
          secrets: ["HUGGING_FACE_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            HUGGING_FACE_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "hf_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            HUGGING_FACE_TOKEN: "$secrets.HUGGING_FACE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
