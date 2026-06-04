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
          "1. Log in to the [Lark Developer Console](https://open.larksuite.com/app/)\n2. Select your app from the list (or create a new one)\n3. Go to the **Credentials & Basic Info** page\n4. Copy your **App ID** and **App Secret**",
        storage: {
          secrets: ["LARK_APP_SECRET", "LARK_ACCESS_TOKEN"],
          variables: ["LARK_APP_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            LARK_APP_ID: {
              label: "App ID",
              required: true,
              storage: "variable",
            },
            LARK_APP_SECRET: {
              label: "App Secret",
              required: true,
              storage: "secret",
            },
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            appId: "$vars.LARK_APP_ID",
            appSecret: "$secrets.LARK_APP_SECRET",
          },
          outputs: {
            accessToken: "$secrets.LARK_ACCESS_TOKEN",
          },
          refreshableSecrets: ["LARK_ACCESS_TOKEN"],
          envBindings: {
            LARK_TOKEN: "$secrets.LARK_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
