import type { ConnectorConfig } from "../connectors";

export const heygen = {
  heygen: {
    label: "HeyGen",
    category: "marketing-content-growth",
    generation: ["video"],
    helpText:
      "Connect your HeyGen account to create AI-generated videos, manage avatars, and automate video production",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [HeyGen](https://app.heygen.com)\n2. Navigate to **Settings > API > API token**\n3. Click to generate your API key\n4. Copy and save the key immediately — you cannot retrieve it after leaving the page, and regenerating a new key will invalidate the previous one",
        storage: {
          secrets: ["HEYGEN_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            HEYGEN_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-heygen-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            HEYGEN_TOKEN: "$secrets.HEYGEN_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
