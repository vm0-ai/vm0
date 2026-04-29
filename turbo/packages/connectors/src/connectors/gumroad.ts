import type { ConnectorConfig } from "../connectors";

export const gumroad = {
  gumroad: {
    label: "Gumroad",
    category: "data-automation-infrastructure",
    tags: ["ecommerce", "store", "products", "sales", "creator"],
    environmentMapping: {
      GUMROAD_TOKEN: "$secrets.GUMROAD_TOKEN",
    },
    helpText:
      "Connect your Gumroad account to manage products, retrieve sales data, handle customers, and verify license keys",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Log in to [Gumroad](https://app.gumroad.com/settings/advanced)\n2. Scroll to the **Applications** section\n3. Click **Generate access token**\n4. Copy the token and paste it here",
        secrets: {
          GUMROAD_TOKEN: {
            label: "Access Token",
            required: true,
            placeholder: "your-gumroad-access-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
