import type { ConnectorConfig } from "../connectors";

export const pdforge = {
  pdforge: {
    label: "PDForge",
    environmentMapping: {
      PDFORGE_API_KEY: "$secrets.PDFORGE_API_KEY",
    },
    helpText:
      "Connect your PDForge account to generate PDF documents from templates",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Create an account on [pdforge](https://pdforge.com)\n2. Two API keys are automatically generated when you create your account\n3. Go to the **API Keys** menu in the sidebar to view your keys\n4. Copy your API key and use it in the `Authorization: Bearer pdfnoodle_api_[your_key]` header",
        secrets: {
          PDFORGE_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "your-pdforge-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
