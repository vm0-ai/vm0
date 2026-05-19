import type { ConnectorConfig } from "../connectors";

export const checkr = {
  checkr: {
    label: "Checkr",
    category: "sales-crm-business-operations",
    tags: [
      "background-checks",
      "screening",
      "candidates",
      "reports",
      "compliance",
    ],
    environmentMapping: {
      CHECKR_TOKEN: "$secrets.CHECKR_TOKEN",
    },
    helpText:
      "Connect your Checkr account to manage candidates, invitations, reports, packages, and background check workflows",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Checkr Dashboard](https://dashboard.checkr.com)\n2. Go to **Account Settings > Developer Settings**\n3. Copy a live or test API key for the account you want to connect\n4. Use only keys and actions that comply with your background check authorization and compliance process",
        secrets: {
          CHECKR_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-checkr-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
