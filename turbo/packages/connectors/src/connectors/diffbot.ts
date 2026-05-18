import type { ConnectorConfig } from "../connectors";

export const diffbot = {
  diffbot: {
    label: "Diffbot",
    category: "data-automation-infrastructure",
    environmentMapping: {
      DIFFBOT_TOKEN: "$secrets.DIFFBOT_TOKEN",
    },
    helpText:
      "Connect Diffbot to extract structured article, product, and entity data from any web page or knowledge graph",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Diffbot](https://app.diffbot.com/get-started/)\n2. Open your account dashboard\n3. Copy the **API token** shown on the dashboard\n4. Pass it as the `token` query parameter on every request",
        secrets: {
          DIFFBOT_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
