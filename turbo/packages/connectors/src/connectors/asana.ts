import type { ConnectorConfig } from "../connectors";

export const asana = {
  asana: {
    label: "Asana",
    category: "engineering-team-execution",
    helpText:
      "Connect your Asana account to manage tasks, projects, portfolios, goals, and team workflows",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Asana to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "ASANA_OAUTH_CLIENT_ID",
          clientSecretEnv: "ASANA_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["ASANA_ACCESS_TOKEN", "ASANA_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [],
          outputs: {
            accessToken: "$secrets.ASANA_ACCESS_TOKEN",
            refreshToken: "$secrets.ASANA_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.ASANA_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.ASANA_ACCESS_TOKEN",
            refreshToken: "$secrets.ASANA_REFRESH_TOKEN",
          },
          refreshableSecrets: ["ASANA_ACCESS_TOKEN"],
          envBindings: {
            ASANA_TOKEN: "$secrets.ASANA_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
