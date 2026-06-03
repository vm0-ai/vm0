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
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "TODOIST_OAUTH_CLIENT_ID",
          clientSecretEnv: "TODOIST_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["TODOIST_ACCESS_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: ["data:read_write", "data:delete", "project:delete"],
          outputs: {
            accessToken: "$secrets.TODOIST_ACCESS_TOKEN",
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TODOIST_TOKEN: "$secrets.TODOIST_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
