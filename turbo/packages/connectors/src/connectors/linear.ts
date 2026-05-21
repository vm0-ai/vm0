import type { ConnectorConfig } from "../connectors";

export const linear = {
  linear: {
    label: "Linear",
    category: "engineering-team-execution",
    tags: ["issues", "tickets", "project-management"],
    environmentMapping: {
      LINEAR_TOKEN: "$secrets.LINEAR_ACCESS_TOKEN",
    },
    helpText: "Connect your Linear account to manage issues and projects",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Linear to grant access.",
        secrets: {
          LINEAR_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          LINEAR_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: false,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      flow: "authorization-code",
      tokenUrl: "https://api.linear.app/oauth/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "LINEAR_OAUTH_CLIENT_ID",
        clientSecretEnv: "LINEAR_OAUTH_CLIENT_SECRET",
      },
      scopes: [
        "read",
        "write",
        "issues:create",
        "comments:create",
        "timeSchedule:write",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
