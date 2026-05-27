import type { ConnectorConfig } from "../connectors";

export const novita = {
  novita: {
    label: "Novita AI",
    category: "ai-general-models",
    generation: ["audio", "image", "text", "video"],
    helpText:
      "Connect your Novita AI account to run LLM, image, video, and audio models through an OpenAI-compatible API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in at [novita.ai](https://novita.ai)\n2. Open **Settings → Key Management**\n3. Click **+ Add New Key**\n4. Copy the key (it begins with `sk_`). Paste it here.",
        grant: {
          kind: "manual",
          fields: {
            NOVITA_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "sk_CoffeeSafeLocalCoffeeSafeLocalCoffeeSafeLoc",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            NOVITA_TOKEN: "$secrets.NOVITA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
