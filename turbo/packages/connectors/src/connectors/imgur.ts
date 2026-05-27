import type { ConnectorConfig } from "../connectors";

export const imgur = {
  imgur: {
    label: "Imgur",
    category: "marketing-content-growth",
    helpText: "Connect your Imgur account to upload, manage, and share images",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Imgur](https://imgur.com)\n2. Go to [Register an Application](https://api.imgur.com/oauth2/addclient)\n3. Fill in the application registration form\n4. After registration, you will receive a **Client ID** and **Client Secret**\n5. Copy and save both credentials",
        grant: {
          kind: "manual",
          fields: {
            IMGUR_CLIENT_ID: {
              label: "Client ID",
              required: true,
              placeholder: "your-imgur-client-id",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            IMGUR_CLIENT_ID: "$secrets.IMGUR_CLIENT_ID",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
