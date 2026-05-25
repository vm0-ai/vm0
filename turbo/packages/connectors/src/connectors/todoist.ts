import type { ConnectorConfig } from "../connectors";

export const todoist = {
  todoist: {
    label: "Todoist",
    category: "engineering-team-execution",
    helpText:
      "Connect your Todoist account to manage tasks, projects, labels, and comments",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Todoist to grant access.",
        grant: {
          kind: "auth-code",
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
        access: {
          kind: "static",
          outputs: {
            TODOIST_TOKEN: "$secrets.TODOIST_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
