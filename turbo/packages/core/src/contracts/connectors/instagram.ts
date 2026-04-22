import type { ConnectorConfig } from "../connectors";

export const instagram = {
  instagram: {
    label: "Instagram",
    environmentMapping: {
      INSTAGRAM_TOKEN: "$secrets.INSTAGRAM_TOKEN",
      INSTAGRAM_BUSINESS_ACCOUNT_ID: "$vars.INSTAGRAM_BUSINESS_ACCOUNT_ID",
    },
    helpText:
      "Connect your Instagram Business account to manage posts, stories, and insights",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Create a Meta app of type **Business** at [Meta for Developers](https://developers.facebook.com/apps)\n2. In your app dashboard, click **Instagram > API setup with Instagram business login** in the left side menu\n3. Click **Generate token** next to the Instagram account you want to access\n4. Log into Instagram when prompted\n5. Copy the access token",
        secrets: {
          INSTAGRAM_TOKEN: {
            label: "Access Token",
            required: true,
          },
          INSTAGRAM_BUSINESS_ACCOUNT_ID: {
            label: "Business Account ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
