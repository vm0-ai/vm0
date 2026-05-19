import type { ConnectorConfig } from "../connectors";

export const reducto = {
  reducto: {
    label: "Reducto",
    category: "data-automation-infrastructure",
    environmentMapping: {
      REDUCTO_TOKEN: "$secrets.REDUCTO_TOKEN",
    },
    helpText:
      "Connect Reducto to parse, OCR, and chunk PDFs, scans, and complex documents into structured JSON",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to the [Reducto Platform](https://platform.reducto.ai)\n2. Open **Settings → API Keys**\n3. Click **Create Key**, name it, and copy the value\n4. Use it as a Bearer token on requests to `https://platform.reducto.ai`",
        secrets: {
          REDUCTO_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
