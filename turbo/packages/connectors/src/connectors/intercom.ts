import type { ConnectorConfig } from "../connectors";

export const intercom = {
  intercom: {
    label: "Intercom",
    category: "communication-collaboration",
    helpText:
      "Connect your Intercom account to manage customer conversations, contacts, messages, and support tickets",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Sign up at the [Intercom Developer Hub](https://app.intercom.com/admins/sign_up/developer) on your Intercom workspace\n2. Create a new app in the Developer Hub\n3. Navigate to **Configure > Authentication** within your app in the [Developer Hub](https://app.intercom.io/a/apps/_/developer-hub/app-packages)\n4. Copy your access token",
        storage: {
          secrets: ["INTERCOM_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            INTERCOM_TOKEN: {
              label: "Access Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            INTERCOM_TOKEN: "$secrets.INTERCOM_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
