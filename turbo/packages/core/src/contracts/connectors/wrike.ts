import type { ConnectorConfig } from "../connectors";

export const wrike = {
  wrike: {
    label: "Wrike",
    category: "engineering-team-execution",
    environmentMapping: {
      WRIKE_TOKEN: "$secrets.WRIKE_TOKEN",
    },
    helpText:
      "Connect your Wrike account to manage projects, tasks, folders, and workflows",
    authMethods: {
      "api-token": {
        label: "Permanent Access Token",
        helpText:
          "1. Navigate to your [Wrike](https://www.wrike.com) workspace\n2. Click on your **profile icon** in the navigation bar\n3. Select **Apps & Integrations**\n4. Click on **API**\n5. Click **+ App**\n6. Enter a name for your integration\n7. Click **Get Token** at the bottom of the window\n8. Copy and securely store your token — it will not be shown again after closing the page\n9. Click **Save**",
        secrets: {
          WRIKE_TOKEN: {
            label: "Permanent Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
