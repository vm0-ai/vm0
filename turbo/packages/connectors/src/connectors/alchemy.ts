import type { ConnectorConfig } from "../connectors";

export const alchemy = {
  alchemy: {
    label: "Alchemy",
    category: "data-automation-infrastructure",
    helpText:
      "Connect Alchemy to use its blockchain RPC, NFT, data, and wallet APIs",
    authMethods: {
      "api-token": {
        label: "API Key or Access Key",
        helpText:
          "1. Log in to the [Alchemy Dashboard](https://dashboard.alchemy.com)\n2. Open **Team Overview** and go to the **Apps** tab\n3. Create or open an app and copy its **API Key**\n4. Use this key in the `Authorization: Bearer` header for supported Alchemy API requests",
        grant: {
          kind: "manual",
          fields: {
            ALCHEMY_API_KEY: {
              label: "API Key or Access Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ALCHEMY_API_KEY: "$secrets.ALCHEMY_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
