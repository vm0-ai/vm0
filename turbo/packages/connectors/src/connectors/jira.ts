import type { ConnectorConfig } from "../connectors";

export const jira = {
  jira: {
    label: "Jira",
    category: "engineering-team-execution",
    tags: ["issues", "tickets", "project-management"],
    helpText:
      "Connect your Jira account to manage projects, issues, sprints, and workflows",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Go to [Atlassian API token management](https://id.atlassian.com/manage-profile/security/api-tokens)\n2. Log in to your Atlassian account\n3. Click **Create API token**\n4. Enter a name that describes what the token is for\n5. Choose an expiration date (between 1 and 365 days)\n6. Click **Create**\n7. Click **Copy to clipboard** and save the token in a secure place (you cannot recover it later)",
        grant: {
          kind: "manual",
          fields: {
            JIRA_API_TOKEN: {
              label: "API Token",
              required: true,
            },
            JIRA_DOMAIN: {
              label: "Jira Domain",
              required: true,
              storage: "variable",
              placeholder: "your-domain.atlassian.net",
            },
            JIRA_EMAIL: {
              label: "Jira Email",
              required: true,
              storage: "variable",
              placeholder: "your-email@example.com",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            JIRA_API_TOKEN: "$secrets.JIRA_API_TOKEN",
            JIRA_DOMAIN: "$vars.JIRA_DOMAIN",
            JIRA_EMAIL: "$vars.JIRA_EMAIL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
