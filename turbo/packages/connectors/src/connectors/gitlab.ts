import type { ConnectorConfig } from "../connectors";

export const gitlab = {
  gitlab: {
    label: "GitLab",
    category: "engineering-team-execution",
    tags: ["git", "vcs", "scm", "repos"],
    helpText:
      "Connect your GitLab account to manage repositories, issues, merge requests, and CI/CD pipelines",
    authMethods: {
      "api-token": {
        label: "Personal Access Token",
        helpText:
          "1. Log in to [GitLab](https://gitlab.com)\n2. Click your avatar in the upper-right corner and select **Edit profile**\n3. In the left sidebar, navigate to **Access > Personal access tokens**\n4. From the **Generate token** dropdown, select **Legacy token**\n5. Enter a name in the **Token name** field\n6. Optionally set an expiration date (defaults to 365 days)\n7. Select the required scopes for your token\n8. Click **Generate token**\n9. Copy and save the token — you cannot view it again after leaving the page",
        storage: {
          secrets: ["GITLAB_TOKEN"],
          variables: ["GITLAB_HOST"],
        },
        grant: {
          kind: "manual",
          fields: {
            GITLAB_TOKEN: {
              label: "Personal Access Token",
              required: true,
            },
            GITLAB_HOST: {
              label: "GitLab Host",
              required: false,
              placeholder: "gitlab.com",
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            GITLAB_TOKEN: "$secrets.GITLAB_TOKEN",
            GITLAB_HOST: {
              valueRef: "$vars.GITLAB_HOST",
              required: false,
            },
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
