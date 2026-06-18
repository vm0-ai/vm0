import type { ConnectorConfig } from "../connectors";

export const insforge = {
  insforge: {
    label: "InsForge",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your InsForge project to access its backend and cloud infrastructure APIs for agent-native apps",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Open your project in the [InsForge dashboard](https://insforge.dev/)\n2. Copy the project's **backend URL** (e.g. `your-project.us-west.insforge.app`) into **Backend URL**\n3. Create or copy the project's **API key** (admin) and paste it into **API Key**\n\nThe anon key is not needed — the API key is the admin credential the agent uses as the backend.",
        storage: {
          secrets: ["INSFORGE_API_KEY"],
          variables: ["INSFORGE_DOMAIN"],
        },
        grant: {
          kind: "manual",
          fields: {
            INSFORGE_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-insforge-api-key",
            },
            INSFORGE_DOMAIN: {
              label: "Backend URL",
              required: true,
              storage: "variable",
              normalize: "host",
              placeholder: "your-project.us-west.insforge.app",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            INSFORGE_API_KEY: "$secrets.INSFORGE_API_KEY",
            INSFORGE_DOMAIN: "$vars.INSFORGE_DOMAIN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
