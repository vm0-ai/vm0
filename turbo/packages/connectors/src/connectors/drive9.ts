import type { ConnectorConfig } from "../connectors";

export const drive9 = {
  drive9: {
    label: "drive9",
    category: "docs-files-knowledge",
    helpText:
      "Connect your drive9 account for agent-friendly file storage with unified path-based operations",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [drive9](https://drive9.ai)\n2. Go to **Settings > API Keys**\n3. Create a new API key\n4. Copy the key (format: `drive9_sk_...`)",
        grant: {
          kind: "manual",
          fields: {
            DRIVE9_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "drive9_sk_...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            DRIVE9_TOKEN: "$secrets.DRIVE9_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
