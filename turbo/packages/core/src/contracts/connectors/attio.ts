import type { ConnectorConfig } from "../connectors";

export const attio = {
  attio: {
    label: "Attio",
    environmentMapping: {
      ATTIO_TOKEN: "$secrets.ATTIO_TOKEN",
    },
    helpText:
      "Connect your Attio workspace to manage CRM records — companies, people, deals, custom objects — plus notes, tasks, lists, and comments",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Open [Attio](https://app.attio.com) and sign in\n2. Open **Workspace settings** from the dropdown beside your workspace name\n3. Click the **Developers** tab\n4. Click **+ New access token**, give it a name, and select the scopes you need\n5. Click **Create**, then copy the token (shown once)",
        secrets: {
          ATTIO_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-attio-access-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
