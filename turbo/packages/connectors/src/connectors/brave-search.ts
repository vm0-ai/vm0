import type { ConnectorConfig } from "../connectors";

export const braveSearch = {
  "brave-search": {
    label: "Brave Search",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Brave Search account to perform privacy-focused web, image, video, and news searches",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Go to the [Brave Search API dashboard](https://api-dashboard.search.brave.com/register) and sign up for an account\n2. Provide a credit card for identity verification (free plans will not be charged)\n3. After registration, your API key will be available in the dashboard\n4. Copy the API key and use it in the `X-Subscription-Token` request header",
        grant: {
          kind: "manual",
          fields: {
            BRAVE_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "BSAxxxxxxxxxxxxxxxx",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BRAVE_API_KEY: "$secrets.BRAVE_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
