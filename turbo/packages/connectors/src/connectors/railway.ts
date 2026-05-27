import type { ConnectorConfig } from "../connectors";

export const railway = {
  railway: {
    label: "Railway",
    category: "engineering-team-execution",
    helpText:
      "Connect your Railway account to manage projects, services, deployments, environments, and variables across every workspace your token can see",
    authMethods: {
      "api-token": {
        label: "Account or Workspace Token",
        helpText:
          "1. Log in to [Railway](https://railway.com)\n2. Open your account or workspace **Settings → Tokens**\n3. Click **Create New Token**, name it, and (for workspace tokens) pick the workspace\n4. Copy the token (UUID v4 format)\n\nUse this connector for cross-project automation. For a single project, use the **Railway Project** connector instead.",
        grant: {
          kind: "manual",
          fields: {
            RAILWAY_TOKEN: {
              label: "Account/Workspace Token",
              required: true,
              placeholder: "00000000-0000-0000-0000-000000000000",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            RAILWAY_TOKEN: "$secrets.RAILWAY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
