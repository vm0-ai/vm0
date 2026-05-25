import type { ConnectorConfig } from "../connectors";

export const firecrawl = {
  firecrawl: {
    label: "Firecrawl",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Firecrawl account to scrape webpages, crawl websites, and extract structured data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Firecrawl](https://www.firecrawl.dev)\n2. Go to your **Dashboard**\n3. Copy your **API Key**",
        grant: {
          kind: "manual",
          fields: {
            FIRECRAWL_TOKEN: {
              label: "API Token",
              required: true,
              placeholder: "fc-xxxxxxxx",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            FIRECRAWL_TOKEN: "$secrets.FIRECRAWL_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
