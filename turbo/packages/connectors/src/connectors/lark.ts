import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const lark = {
  lark: {
    label: "Lark",
    category: "communication-collaboration",
    helpText:
      "Connect your Lark app to manage messages, documents, calendars, and workflows",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.LarkConnector,
        label: "App Credentials",
        helpText:
          "1. Log in to the [Lark Developer Console](https://open.larksuite.com/app/)\n2. Select your app from the list (or create a new one)\n3. Go to the **Credentials & Basic Info** page\n4. Copy your **App ID** and **App Secret**\n5. Use these credentials to call the tenant_access_token API to obtain an access token",
        grant: {
          kind: "manual",
          fields: {
            LARK_TOKEN: {
              label: "App Secret",
              required: true,
              storage: "secret",
            },
            LARK_APP_ID: {
              label: "App ID",
              required: true,
              storage: "variable",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            LARK_TOKEN: "$secrets.LARK_TOKEN",
            LARK_APP_ID: "$vars.LARK_APP_ID",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
