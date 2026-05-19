import type { ConnectorConfig } from "../connectors";

export const mathpix = {
  mathpix: {
    label: "Mathpix",
    category: "data-automation-infrastructure",
    environmentMapping: {
      MATHPIX_APP_KEY: "$secrets.MATHPIX_APP_KEY",
      MATHPIX_APP_ID: "$vars.MATHPIX_APP_ID",
    },
    helpText:
      "Connect Mathpix to convert images, PDFs, and handwriting into LaTeX, Markdown, DOCX, or structured JSON",
    authMethods: {
      "api-token": {
        label: "App ID + App Key",
        helpText:
          "1. Sign in to the [Mathpix Console](https://console.mathpix.com)\n2. Open **API Keys** under your account\n3. Copy your **app_id** and create / copy an **app_key**\n4. Mathpix authenticates with both values sent as the `app_id` and `app_key` request headers",
        secrets: {
          MATHPIX_APP_KEY: {
            label: "App Key",
            required: true,
          },
          MATHPIX_APP_ID: {
            label: "App ID",
            required: true,
            type: "variable",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
