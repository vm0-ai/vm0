import type { ConnectorConfig } from "../connectors";

export const atlassian = {
  atlassian: {
    label: "Atlassian (Jira/Confluence)",
    environmentMapping: {
      ATLASSIAN_TOKEN: "$secrets.ATLASSIAN_TOKEN",
      ATLASSIAN_EMAIL: "$vars.ATLASSIAN_EMAIL",
      ATLASSIAN_DOMAIN: "$vars.ATLASSIAN_DOMAIN",
    },
    helpText:
      "Connect your Atlassian account to manage Jira issues, Confluence pages, and other Atlassian products",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Atlassian](https://id.atlassian.com/manage-profile/security/api-tokens)\n2. Click **Create API token**\n3. Give it a label and click **Create**\n4. Copy the generated token",
        secrets: {
          ATLASSIAN_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-api-token",
          },
          ATLASSIAN_EMAIL: {
            label: "Email",
            required: true,
            placeholder: "you@example.com",
            type: "variable",
          },
          ATLASSIAN_DOMAIN: {
            label: "Domain",
            required: true,
            placeholder: "mycompany",
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
