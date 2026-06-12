import type { ConnectorConfig } from "../connectors";

export const semrush = {
  semrush: {
    label: "Semrush",
    category: "marketing-content-growth",
    tags: [
      "seo",
      "search marketing",
      "keyword research",
      "traffic analytics",
      "competitive intelligence",
    ],
    helpText:
      "Connect your Semrush account to access SEO, keyword, domain, traffic, and competitive research data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to [Semrush](https://www.semrush.com)\n2. Click your profile icon in the top-right corner\n3. Select **Subscription info**, then open the **API Units** tab\n4. Copy your API key",
        storage: {
          secrets: ["SEMRUSH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            SEMRUSH_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "your-semrush-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SEMRUSH_TOKEN: "$secrets.SEMRUSH_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
