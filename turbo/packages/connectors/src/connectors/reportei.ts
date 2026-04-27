import type { ConnectorConfig } from "../connectors";

export const reportei = {
  reportei: {
    label: "Reportei",
    category: "marketing-content-growth",
    environmentMapping: {
      REPORTEI_TOKEN: "$secrets.REPORTEI_TOKEN",
    },
    helpText:
      "Connect your Reportei account to generate and manage marketing reports with automated analytics",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Reportei](https://app.reportei.com)\n2. Go to **Company Settings** (Configurações da Empresa)\n3. Navigate to the **API Reportei** section\n4. Click **Generate new token** or copy your existing token",
        secrets: {
          REPORTEI_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "your-reportei-api-token",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
