import type { ConnectorConfig } from "../connectors";

export const shopify = {
  shopify: {
    label: "Shopify",
    category: "data-automation-infrastructure",
    tags: ["ecommerce", "store", "products", "orders"],
    helpText:
      "Connect your Shopify store to manage products, orders, customers, and inventory through the Admin API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. In your Shopify admin, go to **Settings → Apps and sales channels → Develop apps**\n2. Click **Create an app**, name it (e.g. `vm0`), and open it\n3. Under **Configuration → Admin API integration**, grant the scopes you need (e.g. `read_products`, `read_orders`)\n4. Click **Install app** and then **Reveal token once** — copy the Admin API access token (starts with `shpat_`)\n5. For the **Store subdomain** below, enter only the subdomain of your `.myshopify.com` URL (for `acme.myshopify.com` enter `acme`)",
        grant: {
          kind: "manual",
          fields: {
            SHOPIFY_TOKEN: {
              label: "Admin API Access Token",
              required: true,
              placeholder: "shpat_...",
            },
            SHOPIFY_SHOP: {
              label: "Store Subdomain",
              required: true,
              storage: "variable",
              placeholder: "acme",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            SHOPIFY_TOKEN: "$secrets.SHOPIFY_TOKEN",
            SHOPIFY_SHOP: "$vars.SHOPIFY_SHOP",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
