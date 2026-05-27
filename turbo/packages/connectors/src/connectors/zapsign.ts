import type { ConnectorConfig } from "../connectors";

export const zapsign = {
  zapsign: {
    label: "ZapSign",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your ZapSign account to create documents for electronic signature and track signing status",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to your [ZapSign](https://app.zapsign.com) account\n2. Go to **Settings**\n3. Navigate to **Integrations**\n4. Select **ZAPSIGN API**\n5. Copy your API token",
        grant: {
          kind: "manual",
          fields: {
            ZAPSIGN_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "your-zapsign-api-token",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            ZAPSIGN_TOKEN: "$secrets.ZAPSIGN_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
