import type { ConnectorConfig } from "../connectors";

export const sociavault = {
  sociavault: {
    label: "SociaVault",
    category: "marketing-content-growth",
    helpText:
      "Connect SociaVault to extract public social media, ad library, and Google Search data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up or log in to the [SociaVault Dashboard](https://sociavault.com)\n2. Copy your API key\n3. SociaVault authenticates requests with the `X-API-Key` header",
        storage: {
          secrets: ["SOCIAVAULT_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            SOCIAVAULT_TOKEN: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SOCIAVAULT_TOKEN: "$secrets.SOCIAVAULT_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
