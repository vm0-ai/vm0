import type { ConnectorConfig } from "../connectors";

export const onyx = {
  onyx: {
    label: "Onyx",
    category: "docs-files-knowledge",
    helpText:
      "Connect your Onyx account to search internal knowledge bases, chat with AI agents, and index documents",
    authMethods: {
      "api-token": {
        label: "API Key / PAT",
        helpText:
          "1. Log in to [Onyx Cloud](https://cloud.onyx.app)\n2. Go to **Settings → Accounts & Access**\n3. Click **Create New Token**\n4. Give it a name and choose an expiration\n5. Copy the token immediately — it is shown only once",
        storage: {
          secrets: ["ONYX_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            ONYX_TOKEN: {
              label: "API Key or Personal Access Token",
              required: true,
              placeholder: "onyx_pat_...",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ONYX_TOKEN: "$secrets.ONYX_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
