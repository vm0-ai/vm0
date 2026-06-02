import type { ConnectorConfig } from "../connectors";

export const bitrefill = {
  bitrefill: {
    label: "Bitrefill",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Bitrefill account to browse products, create invoices, track orders, and manage purchases programmatically",
    authMethods: {
      "api-token": {
        label: "Personal API Token",
        helpText:
          "1. Sign in to [Bitrefill](https://www.bitrefill.com)\n" +
          "2. Go to **Account > Developers**\n" +
          "3. Generate an API key\n" +
          "4. Copy the Personal API token\n\n" +
          "This connector currently supports Bitrefill Personal API Bearer tokens. Business and Affiliate Basic auth credentials are not supported yet.",
        storage: {
          secrets: ["BITREFILL_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            BITREFILL_TOKEN: {
              label: "Personal API Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BITREFILL_TOKEN: "$secrets.BITREFILL_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
