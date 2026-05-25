import type { ConnectorConfig } from "../connectors";

export const reducto = {
  reducto: {
    label: "Reducto",
    category: "data-automation-infrastructure",
    helpText:
      "Connect Reducto to parse, OCR, and chunk PDFs, scans, and complex documents into structured JSON",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to the [Reducto Platform](https://platform.reducto.ai)\n2. Open **Settings → API Keys**\n3. Click **Create Key**, name it, and copy the value\n4. Use it as a Bearer token on requests to `https://platform.reducto.ai`",
        grant: {
          kind: "manual",
          fields: {
            REDUCTO_TOKEN: {
              label: "API Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            REDUCTO_TOKEN: "$secrets.REDUCTO_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
