import type { ConnectorConfig } from "../connectors";

export const line = {
  line: {
    label: "LINE",
    category: "communication-collaboration",
    environmentMapping: {
      LINE_TOKEN: "$secrets.LINE_TOKEN",
    },
    helpText:
      "Connect your LINE account to send messages, manage channels, and access the LINE Messaging API",
    authMethods: {
      "api-token": {
        label: "Channel Access Token",
        helpText:
          "1. Log in to the [LINE Developers Console](https://developers.line.biz/console)\n2. Select your provider and channel\n3. Go to the **Messaging API** tab\n4. Issue or copy the **Channel access token (long-lived)**",
        secrets: {
          LINE_TOKEN: {
            label: "Channel Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
