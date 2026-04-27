import type { ConnectorConfig } from "../connectors";

export const pushinator = {
  pushinator: {
    label: "Pushinator",
    category: "communication-collaboration",
    environmentMapping: {
      PUSHINATOR_TOKEN: "$secrets.PUSHINATOR_TOKEN",
    },
    helpText:
      "Connect your Pushinator account to send push notifications to mobile devices",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          PUSHINATOR_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-pushinator-api-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
