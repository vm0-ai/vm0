import type { ConnectorConfig } from "../connector-config";
import { FeatureSwitchKey } from "../feature-switch-key";

export const paypal = {
  paypal: {
    label: "PayPal",
    category: "sales-crm-business-operations",
    tags: ["payments", "orders", "invoices", "payouts", "transactions"],
    helpText:
      "Connect a PayPal REST app to manage orders, payments, invoices, payouts, disputes, and transaction reporting",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.PayPalConnector,
        label: "REST App Credentials",
        helpText:
          "1. Open the [PayPal Developer Dashboard](https://developer.paypal.com/dashboard/applications/live)\n2. Create or select a live REST app\n3. Copy the client ID and client secret",
        storage: {
          version: 1,
          secrets: ["PAYPAL_CLIENT_SECRET", "PAYPAL_ACCESS_TOKEN"],
          variables: ["PAYPAL_CLIENT_ID"],
        },
        grant: {
          kind: "manual",
          fields: {
            PAYPAL_CLIENT_ID: {
              label: "Client ID",
              publicId: "clientId",
              required: true,
              storage: "variable",
            },
            PAYPAL_CLIENT_SECRET: {
              label: "Client Secret",
              publicId: "clientSecret",
              required: true,
            },
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            clientId: "$vars.PAYPAL_CLIENT_ID",
            clientSecret: "$secrets.PAYPAL_CLIENT_SECRET",
          },
          outputs: { accessToken: "$secrets.PAYPAL_ACCESS_TOKEN" },
          refreshableSecrets: ["PAYPAL_ACCESS_TOKEN"],
          envBindings: { PAYPAL_TOKEN: "$secrets.PAYPAL_ACCESS_TOKEN" },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
