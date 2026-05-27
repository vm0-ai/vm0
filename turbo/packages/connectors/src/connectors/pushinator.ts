import type { ConnectorConfig } from "../connectors";

export const pushinator = {
  pushinator: {
    label: "Pushinator",
    category: "communication-collaboration",
    helpText:
      "Connect your Pushinator account to send push notifications to mobile devices",
    authMethods: {
      "api-token": {
        label: "API Token",
        grant: {
          kind: "manual",
          fields: {
            PUSHINATOR_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "your-pushinator-api-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            PUSHINATOR_TOKEN: "$secrets.PUSHINATOR_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
