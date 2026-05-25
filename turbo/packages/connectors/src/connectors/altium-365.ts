import type { ConnectorConfig } from "../connectors";

export const altium365 = {
  "altium-365": {
    label: "Altium 365",
    category: "engineering-team-execution",
    tags: ["pcb", "eda", "requirements", "altium", "systems-portal"],
    helpText:
      "Connect your Altium 365 Requirements & Systems Portal workspace to manage projects, requirements, components, traces, and verification tests",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to your Altium 365 workspace (e.g. `https://<workspace>.365.altium.com`)\n2. Open **Settings → User Tokens** and click **Generate**\n3. Copy the generated token — it is shown only once and expires three months from creation\n4. Paste the token and your full workspace URL (including `https://`) below",
        grant: {
          kind: "manual",
          fields: {
            ALTIUM365_TOKEN: {
              label: "User Token",
              required: true,
              placeholder: "your-altium-365-user-token",
            },
            ALTIUM365_WORKSPACE_URL: {
              label: "Workspace URL",
              required: true,
              storage: "variable",
              placeholder: "https://your-workspace.365.altium.com",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            ALTIUM365_TOKEN: "$secrets.ALTIUM365_TOKEN",
            ALTIUM365_WORKSPACE_URL: "$vars.ALTIUM365_WORKSPACE_URL",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
