import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const bill = {
  bill: {
    label: "BILL",
    category: "sales-crm-business-operations",
    tags: ["bill.com", "accounts payable", "expenses", "budgets"],
    helpText:
      "Connect BILL to manage Spend & Expense budgets, users, cards, transactions, and reimbursements",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.BillConnector,
        label: "Spend & Expense API Token",
        helpText:
          "1. Sign in to BILL\n2. Open **Settings** and select **API & Webhooks**\n3. Create a Spend & Expense API token\n4. Copy the token",
        storage: { secrets: ["BILL_TOKEN"], variables: [] },
        grant: {
          kind: "manual",
          fields: {
            BILL_TOKEN: {
              label: "API Token",
              publicId: "apiToken",
              required: true,
              placeholder: "CoffeeSafeLocalCoffeeSafeLocal",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: { BILL_TOKEN: "$secrets.BILL_TOKEN" },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
