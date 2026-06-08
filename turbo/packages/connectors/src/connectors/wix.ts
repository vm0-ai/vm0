import type { ConnectorConfig } from "../connectors";

export const wix = {
  wix: {
    label: "Wix",
    category: "marketing-content-growth",
    helpText:
      "Connect your Wix account to manage sites, collections, and content",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to your [Wix](https://www.wix.com) account (account owner or co-owner access required)\n2. Go to the [API Keys Manager](https://manage.wix.com/account/api-keys)\n3. Create a new API key and assign the required permissions\n4. Copy the generated API key and store it securely",
        storage: {
          secrets: ["WIX_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            WIX_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-wix-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            WIX_TOKEN: "$secrets.WIX_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
