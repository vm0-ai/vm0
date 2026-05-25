import type { ConnectorConfig } from "../connectors";

export const runway = {
  runway: {
    label: "Runway",
    category: "ai-image-video",
    generation: ["video"],
    helpText:
      "Connect your Runway account to generate AI videos from images, text, or video inputs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up for an account in the [Runway Developer Portal](https://dev.runwayml.com/)\n2. After signing up, create a new organization\n3. Click to the **API Keys** tab\n4. Create a new key, giving it a descriptive name\n5. Copy the key immediately and store it in a safe place — it will only be shown once",
        grant: {
          kind: "manual",
          fields: {
            RUNWAY_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-runway-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            RUNWAY_TOKEN: "$secrets.RUNWAY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
