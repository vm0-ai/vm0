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
      tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
      scopes: [],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
