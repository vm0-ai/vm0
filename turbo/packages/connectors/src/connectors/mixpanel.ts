import type { ConnectorConfig } from "../connectors";

export const mixpanel = {
  mixpanel: {
    label: "Mixpanel",
    category: "data-automation-infrastructure",
    tags: ["analytics", "product-analytics", "events"],
    helpText:
      "Connect your Mixpanel project to query Insights, Funnels, JQL, raw event export, and ingest events via /import",
    authMethods: {
      "api-token": {
        label: "Service Account",
        helpText:
          "1. In Mixpanel, open **Organization Settings → Service Accounts** (or **Project Settings → Service Accounts**)\n2. Click **Add Service Account**, give it a name, and choose a role (minimum **Member**); optionally set an expiration\n3. Copy the **Username** and **Secret** immediately — the secret is only shown once\n4. Open **Project Settings → Overview → Access Keys** and copy your **Project ID**\n5. Paste all three values below",
        storage: {
          secrets: [
            "MIXPANEL_SERVICE_ACCOUNT_USERNAME",
            "MIXPANEL_SERVICE_ACCOUNT_SECRET",
          ],
          variables: ["MIXPANEL_PROJECT_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            MIXPANEL_SERVICE_ACCOUNT_USERNAME: {
              label: "Service Account Username",
              required: true,
              placeholder: "my-sa.12ab34",
            },
            MIXPANEL_SERVICE_ACCOUNT_SECRET: {
              label: "Service Account Secret",
              required: true,
            },
            MIXPANEL_PROJECT_ID: {
              label: "Project ID",
              required: true,
              storage: "variable",
              placeholder: "1234567",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            MIXPANEL_SERVICE_ACCOUNT_USERNAME:
              "$secrets.MIXPANEL_SERVICE_ACCOUNT_USERNAME",
            MIXPANEL_SERVICE_ACCOUNT_SECRET:
              "$secrets.MIXPANEL_SERVICE_ACCOUNT_SECRET",
            MIXPANEL_PROJECT_ID: "$vars.MIXPANEL_PROJECT_ID",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
