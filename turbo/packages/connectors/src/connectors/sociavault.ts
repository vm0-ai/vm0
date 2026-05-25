import type { ConnectorConfig } from "../connectors";

export const sociavault = {
  sociavault: {
    label: "SociaVault",
    category: "marketing-content-growth",
    environmentMapping: {
      SOCIAVAULT_TOKEN: "$secrets.SOCIAVAULT_TOKEN",
    },
    helpText:
      "Connect SociaVault to extract public social media, ad library, and Google Search data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign up or log in to the [SociaVault Dashboard](https://sociavault.com)\n2. Copy your API key\n3. SociaVault authenticates requests with the `X-API-Key` header",
        secrets: {
          SOCIAVAULT_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
