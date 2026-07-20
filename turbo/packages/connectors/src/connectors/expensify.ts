import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const expensify = {
  expensify: {
    label: "Expensify",
    category: "sales-crm-business-operations",
    tags: ["expenses", "reports", "reconciliation", "accounting"],
    helpText:
      "Connect Expensify Integration Server to export expense reports, reconcile transactions, and manage reports",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.ExpensifyConnector,
        label: "Partner Credentials",
        helpText:
          "1. Sign in to Expensify\n2. Open [Integration Server credentials](https://www.expensify.com/tools/integrations/)\n3. Generate and copy the partner user ID and partner user secret",
        storage: {
          version: 1,
          secrets: ["EXPENSIFY_PARTNER_USER_SECRET"],
          variables: ["EXPENSIFY_PARTNER_USER_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            EXPENSIFY_PARTNER_USER_ID: {
              label: "Partner User ID",
              publicId: "partnerUserId",
              required: true,
              storage: "variable",
            },
            EXPENSIFY_PARTNER_USER_SECRET: {
              label: "Partner User Secret",
              publicId: "partnerUserSecret",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            EXPENSIFY_PARTNER_USER_ID: "$vars.EXPENSIFY_PARTNER_USER_ID",
            EXPENSIFY_PARTNER_USER_SECRET:
              "$secrets.EXPENSIFY_PARTNER_USER_SECRET",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
