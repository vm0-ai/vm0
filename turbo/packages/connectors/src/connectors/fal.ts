import type { ConnectorConfig } from "../connectors";

export const fal = {
  fal: {
    label: "fal.ai",
    category: "ai-image-video",
    generation: ["image", "video"],
    helpText:
      "Connect your fal.ai account to run AI models for image generation, video generation, and other AI tasks",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [fal Dashboard Keys page](https://fal.ai/dashboard/keys)\n2. Click the **Create Key** button\n3. Provide a name for your key and select the appropriate scope (**API** for calling models, or **ADMIN** for full access)\n4. Copy the key immediately — you will not be able to see it again",
        grant: {
          kind: "manual",
          fields: {
            FAL_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "fal_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            FAL_TOKEN: "$secrets.FAL_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
