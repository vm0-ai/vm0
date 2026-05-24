import type { ConnectorConfig } from "../connectors";

export const printful = {
  printful: {
    label: "Printful",
    category: "data-automation-infrastructure",
    tags: ["ecommerce", "fulfillment", "products", "orders"],
    environmentMapping: {
      PRINTFUL_TOKEN: "$secrets.PRINTFUL_TOKEN",
    },
    helpText:
      "Connect your Printful account to manage catalog data, products, orders, stores, and fulfillment workflows through the Printful API",
    authMethods: {
      "api-token": {
        label: "Private Token",
        helpText:
          "1. Log in to the [Printful Developer Portal](https://developers.printful.com/)\n" +
          "2. Generate a **Private Token** with the scopes your workflow needs\n" +
          "3. Copy the token and use it as a Bearer token\n\n" +
          "For account-level Private Tokens, Printful requires an `X-PF-Store-Id` header on store-scoped requests.",
        secrets: {
          PRINTFUL_TOKEN: {
            label: "Private Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
