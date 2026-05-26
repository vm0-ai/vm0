import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const webflow = {
  webflow: {
    label: "Webflow",
    category: "marketing-content-growth",
    helpText:
      "Connect your Webflow account to manage sites, pages, CMS collections, and ecommerce",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.WebflowConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Webflow to grant access.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://api.webflow.com/oauth/access_token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "WEBFLOW_OAUTH_CLIENT_ID",
            clientSecretEnv: "WEBFLOW_OAUTH_CLIENT_SECRET",
          },
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
        access: {
          kind: "static",
          outputs: {
            WEBFLOW_TOKEN: "$secrets.WEBFLOW_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      "api-token": {
        label: "Site Token",
        helpText:
          "1. Log in to [Webflow](https://webflow.com) (site administrator access required)\n2. In your workspace, find the site and click the gear icon to open **Site Settings**\n3. In the left sidebar, select **Apps & integrations**\n4. Scroll to the bottom of the page to the **API access** section\n5. Click **Generate API token**\n6. Enter a name for your token and choose the required scopes\n7. Click **Generate token**\n8. Copy the generated token and save it in a secure location",
        grant: {
          kind: "manual",
          fields: {
            WEBFLOW_TOKEN: {
              label: "Site Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            WEBFLOW_TOKEN: "$secrets.WEBFLOW_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
