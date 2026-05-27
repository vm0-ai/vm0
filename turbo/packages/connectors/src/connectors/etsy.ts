import type { ConnectorConfig } from "../connectors";

export const etsy = {
  etsy: {
    label: "Etsy",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Etsy developer account to search listings, manage shop data, and access product information",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Etsy](https://www.etsy.com/developers/your-apps)\n" +
          "2. Click **Create a New App** (or select an existing app)\n" +
          "3. Copy the **Keystring** and **Shared Secret**\n" +
          "4. Paste both values joined with a colon: `keystring:shared_secret`",
        grant: {
          kind: "manual",
          fields: {
            ETSY_TOKEN: {
              label: "API Key (keystring:shared_secret)",
              required: true,
              placeholder: "c0ffee5afe10ca1c0ffee5af:e10ca15afe",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ETSY_TOKEN: "$secrets.ETSY_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
