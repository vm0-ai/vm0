import type { ConnectorConfig } from "../connectors";

export const supadata = {
  supadata: {
    label: "Supadata",
    category: "data-automation-infrastructure",
    environmentMapping: {
      SUPADATA_TOKEN: "$secrets.SUPADATA_TOKEN",
    },
    helpText:
      "Connect your Supadata account to extract YouTube transcripts, channel data, and video metadata",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [Supadata Dashboard](https://dash.supadata.ai)\n2. Sign up for an account (no credit card required)\n3. Your API key will be generated automatically\n4. Use it in API requests with the header `x-api-key: [your_api_key]`",
        secrets: {
          SUPADATA_TOKEN: {
            label: "API Key",
            required: true,
            placeholder: "your-supadata-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
