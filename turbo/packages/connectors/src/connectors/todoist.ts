import type { ConnectorConfig } from "../connectors";

export const todoist = {
  todoist: {
    label: "Todoist",
    category: "engineering-team-execution",
    environmentMapping: {
      TODOIST_TOKEN: "$secrets.TODOIST_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Todoist account to manage tasks, projects, labels, and comments",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Todoist to grant access.",
        secrets: {
          TODOIST_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://todoist.com/oauth/authorize",
      tokenUrl: "https://todoist.com/oauth/access_token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "TODOIST_OAUTH_CLIENT_ID",
        clientSecretEnv: "TODOIST_OAUTH_CLIENT_SECRET",
      },
      scopes: ["data:read_write", "data:delete", "project:delete"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
