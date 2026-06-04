import type { ConnectorConfig } from "../connectors";

export const miro = {
  miro: {
    label: "Miro",
    category: "docs-files-knowledge",
    helpText:
      "Connect your Miro account to create and manage boards, sticky notes, shapes, text, and other items on the visual collaboration whiteboard",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Go to [Miro App Settings](https://miro.com/app/settings/user-profile/apps) and click **Create new app**\n2. Fill in the app name and description\n3. **Important:** when asked about token expiration, select **Non-expiring access token** — this choice is permanent for the app\n4. On the app's page, open **Permissions** and check the scopes you need (e.g. `boards:read`, `boards:write`)\n5. Click **Install app and get OAuth token**, select your team, and copy the token\n6. Paste the token here",
        storage: {
          secrets: ["MIRO_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            MIRO_TOKEN: {
              label: "Access Token",
              required: true,
              placeholder: "non-expiring access token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MIRO_TOKEN: "$secrets.MIRO_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
