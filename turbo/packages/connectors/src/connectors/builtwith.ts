import type { ConnectorConfig } from "../connectors";

export const builtwith = {
  builtwith: {
    label: "BuiltWith",
    category: "sales-crm-business-operations",
    helpText:
      "Connect BuiltWith to look up the technology stack, traffic, and contact data for any website",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [BuiltWith](https://api.builtwith.com)\n2. Open the **API access** page in your account\n3. Copy your **API key**\n4. Pass it as the `KEY` query parameter on every request",
        storage: {
          secrets: ["BUILTWITH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            BUILTWITH_TOKEN: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BUILTWITH_TOKEN: "$secrets.BUILTWITH_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
