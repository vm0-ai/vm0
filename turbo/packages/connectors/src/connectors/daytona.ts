import type { ConnectorConfig } from "../connectors";

export const daytona = {
  daytona: {
    label: "Daytona",
    category: "data-automation-infrastructure",
    tags: ["sandbox", "sandboxes", "code-execution", "managed-agents"],
    helpText:
      "Connect your Daytona account to create, run, and manage cloud sandboxes for code execution and agent workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in at [app.daytona.io](https://app.daytona.io)\n2. Open **API Keys**\n3. Click **Create API Key**\n4. Copy the generated key and paste it here.",
        storage: {
          secrets: ["DAYTONA_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            DAYTONA_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-daytona-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            DAYTONA_API_KEY: "$secrets.DAYTONA_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
