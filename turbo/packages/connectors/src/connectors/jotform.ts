import type { ConnectorConfig } from "../connectors";

export const jotform = {
  jotform: {
    label: "Jotform",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Jotform account to manage forms, submissions, and automate form workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Jotform account](https://www.jotform.com/myaccount/api)\n2. Navigate to **Settings** → **API**\n3. Click **Create New Key**\n4. Copy your **API Key**",
        grant: {
          kind: "manual",
          fields: {
            JOTFORM_TOKEN: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            JOTFORM_TOKEN: "$secrets.JOTFORM_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
