import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const webflow = {
  webflow: {
    label: "Webflow",
    category: "marketing-content-growth",
    environmentMapping: {
      WEBFLOW_TOKEN: "$secrets.WEBFLOW_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Webflow account to manage sites, pages, CMS collections, and ecommerce",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.WebflowConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Webflow to grant access.",
        secrets: {
          WEBFLOW_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Site Token",
        helpText:
          "1. Log in to [Webflow](https://webflow.com) (site administrator access required)\n2. In your workspace, find the site and click the gear icon to open **Site Settings**\n3. In the left sidebar, select **Apps & integrations**\n4. Scroll to the bottom of the page to the **API access** section\n5. Click **Generate API token**\n6. Enter a name for your token and choose the required scopes\n7. Click **Generate token**\n8. Copy the generated token and save it in a secure location",
        secrets: {
          WEBFLOW_TOKEN: {
            label: "Site Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://webflow.com/oauth/authorize",
      tokenUrl: "https://api.webflow.com/oauth/access_token",
      scopes: [
        "authorized_user:read",
        "sites:read",
        "sites:write",
        "pages:read",
        "pages:write",
        "cms:read",
        "cms:write",
        "assets:read",
        "assets:write",
        "forms:read",
        "ecommerce:read",
        "ecommerce:write",
        "users:read",
        "workspace:read",
        "custom_code:read",
        "custom_code:write",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
