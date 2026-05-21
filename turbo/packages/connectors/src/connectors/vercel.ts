import type { ConnectorConfig } from "../connectors";

export const vercel = {
  vercel: {
    label: "Vercel",
    category: "engineering-team-execution",
    environmentMapping: {
      VERCEL_TOKEN: "$secrets.VERCEL_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Vercel account to manage deployments, projects, and domains",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Vercel to grant access.",
        secrets: {
          VERCEL_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      flow: "authorization-code",
      tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "VERCEL_OAUTH_CLIENT_ID",
        clientSecretEnv: "VERCEL_OAUTH_CLIENT_SECRET",
      },
      scopes: [],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
