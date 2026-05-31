import type { ConnectorConfig } from "../connectors";

const OAUTH_TOKEN_URL = "https://gumroad.com/oauth/token";

export const gumroad = {
  gumroad: {
    label: "Gumroad",
    category: "data-automation-infrastructure",
    tags: ["ecommerce", "store", "products", "sales", "creator"],
    helpText:
      "Connect your Gumroad account to manage products, retrieve sales data, handle customers, and verify license keys",
    authMethods: {
      oauth: {
        label: "OAuth (Recommended)",
        helpText: "Sign in with Gumroad to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GUMROAD_OAUTH_CLIENT_ID",
          clientSecretEnv: "GUMROAD_OAUTH_CLIENT_SECRET",
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [
            "view_profile",
            "edit_products",
            "view_sales",
            "mark_sales_as_shipped",
            "edit_sales",
          ],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          accessToken: "GUMROAD_ACCESS_TOKEN",
          refreshToken: "GUMROAD_REFRESH_TOKEN",
          envBindings: {
            GUMROAD_TOKEN: "$secrets.GUMROAD_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Log in to [Gumroad](https://app.gumroad.com/settings/advanced)\n2. Scroll to the **Applications** section\n3. Click **Generate access token**\n4. Copy the token and paste it here",
        grant: {
          kind: "manual",
          fields: {
            GUMROAD_TOKEN: {
              label: "Access Token",
              required: true,
              placeholder: "your-gumroad-access-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            GUMROAD_TOKEN: "$secrets.GUMROAD_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
