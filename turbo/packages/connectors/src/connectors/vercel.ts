import type { ConnectorConfig } from "../connectors";

export const vercel = {
  vercel: {
    label: "Vercel",
    category: "engineering-team-execution",
    helpText:
      "Connect your Vercel account to manage deployments, projects, and domains",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Vercel to grant access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://api.vercel.com/v2/oauth/access_token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "VERCEL_OAUTH_CLIENT_ID",
            clientSecretEnv: "VERCEL_OAUTH_CLIENT_SECRET",
          },
          scopes: [],
        },
        access: {
          kind: "static",
          outputs: {
            VERCEL_TOKEN: "$secrets.VERCEL_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
