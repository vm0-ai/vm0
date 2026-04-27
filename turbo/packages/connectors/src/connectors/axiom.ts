import type { ConnectorConfig } from "../connectors";

export const axiom = {
  axiom: {
    label: "Axiom",
    category: "data-automation-infrastructure",
    environmentMapping: {
      AXIOM_TOKEN: "$secrets.AXIOM_TOKEN",
    },
    helpText:
      "Connect your Axiom account to query logs, manage datasets, and access observability data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Axiom](https://app.axiom.co)\n2. Go to **Settings > API Tokens**\n3. Create a new API token with the required permissions\n4. Copy the token",
        secrets: {
          AXIOM_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "xaat-...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
