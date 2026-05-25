import type { ConnectorConfig } from "../connectors";

export const serpapi = {
  serpapi: {
    label: "SerpApi",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your SerpApi account to search Google, Bing, YouTube and other search engines programmatically",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to [SerpApi](https://serpapi.com) and sign up for an account (free plan available with 250 searches/month)\n2. Log in and go to your [Dashboard](https://serpapi.com/dashboard)\n3. Your API key is displayed on the dashboard\n4. Copy the API key",
        grant: {
          kind: "manual",
          fields: {
            SERPAPI_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-serpapi-api-key",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            SERPAPI_TOKEN: "$secrets.SERPAPI_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
