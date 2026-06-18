import type { ConnectorConfig } from "../connectors";

export const render = {
  render: {
    label: "Render",
    category: "engineering-team-execution",
    helpText:
      "Connect your Render account to manage services, deploys, environment groups, projects, custom domains, logs, metrics, and account settings",
    tags: ["paas", "deployments", "hosting", "services"],
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Render](https://dashboard.render.com)\n2. Open **Account Settings > API Keys**\n3. Create a new API key\n4. Copy the API key immediately; Render only displays it in full when it is created\n\nRender API keys can access every workspace and service available to your Render account.",
        storage: {
          secrets: ["RENDER_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            RENDER_API_KEY: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            RENDER_API_KEY: "$secrets.RENDER_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
