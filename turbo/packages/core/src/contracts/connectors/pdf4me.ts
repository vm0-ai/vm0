import type { ConnectorConfig } from "../connectors";

export const pdf4me = {
  pdf4me: {
    label: "PDF4me",
    environmentMapping: {
      PDF4ME_TOKEN: "$secrets.PDF4ME_TOKEN",
    },
    helpText:
      "Connect your PDF4me account to convert, merge, split, compress, and manipulate PDF documents",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Register for an account at [PDF4me](https://portal.pdf4me.com) using email/password or via Google, Microsoft, Apple, or Facebook\n2. Go to the **Billing Info** section and select **Start Free Trial**\n3. After activation, you will be redirected to the **Dashboard**\n4. Find and copy your API Key from the Dashboard",
        secrets: {
          PDF4ME_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-pdf4me-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
