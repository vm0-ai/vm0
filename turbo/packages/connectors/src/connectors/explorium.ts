import type { ConnectorConfig } from "../connectors";

export const explorium = {
  explorium: {
    label: "Explorium",
    category: "sales-crm-business-operations",
    helpText:
      "Connect your Explorium account to access business data enrichment, prospect discovery, and AI-powered data insights",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Explorium Admin Portal](https://admin.explorium.ai)\n2. Navigate to **Access & Authentication > Getting Your API Key**\n3. Click the **Show Key** button to reveal the masked API key\n4. Click the **Copy Key** button to copy it",
        grant: {
          kind: "manual",
          fields: {
            EXPLORIUM_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-explorium-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            EXPLORIUM_TOKEN: "$secrets.EXPLORIUM_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
