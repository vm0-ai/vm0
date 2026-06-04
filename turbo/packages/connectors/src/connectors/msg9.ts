import type { ConnectorConfig } from "../connectors";

export const msg9 = {
  msg9: {
    label: "msg9",
    category: "communication-collaboration",
    helpText:
      "Connect your msg9 account to send messages, manage inboxes, contacts, lists, channels, and skills",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [msg9](https://www.msg9.io)\n2. Go to **Settings > API Keys**\n3. Create a new API key\n4. Copy the key (format: `msg9_sk_...`)",
        storage: {
          secrets: ["MSG9_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MSG9_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "msg9_sk_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MSG9_TOKEN: "$secrets.MSG9_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
