import type { ConnectorConfig } from "../connectors";

export const railwayProject = {
  "railway-project": {
    label: "Railway Project",
    category: "engineering-team-execution",
    helpText:
      "Connect a single Railway project with a project-scoped token for tighter blast radius (redeploys, variable management, deployment status inside one project/environment)",
    authMethods: {
      "api-token": {
        label: "Project Token",
        helpText:
          "1. Log in to [Railway](https://railway.com) and open the target project\n2. Go to **Project Settings → Tokens**\n3. Click **Create Token**, pick the environment, and name it\n4. Copy the token (UUID v4 format)\n\nThis token is sent via the `Project-Access-Token` header and is bound to one environment in one project. For cross-project automation use the **Railway** connector instead.",
        storage: {
          secrets: ["RAILWAY_PROJECT_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            RAILWAY_PROJECT_TOKEN: {
              label: "Project Token",
              required: true,
              placeholder: "00000000-0000-0000-0000-000000000000",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            RAILWAY_PROJECT_TOKEN: "$secrets.RAILWAY_PROJECT_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
