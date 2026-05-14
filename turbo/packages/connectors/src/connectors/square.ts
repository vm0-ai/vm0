import type { ConnectorConfig } from "../connectors";

export const square = {
  square: {
    label: "Square",
    category: "sales-crm-business-operations",
    environmentMapping: {
      SQUARE_TOKEN: "$secrets.SQUARE_TOKEN",
    },
    helpText:
      "Connect your Square account to manage payments, refunds, orders, customers, catalog, invoices, and inventory",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Sign in to the [Square Developer Console](https://developer.squareup.com/apps)\n2. Open (or create) an application\n3. In the left pane, choose **Credentials**\n4. At the top of the page, select **Production**\n5. Copy the **Production Access token** (format: `EAAA...`)",
        secrets: {
          SQUARE_TOKEN: {
            label: "Access Token",
            required: true,
            placeholder: "EAAA...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
