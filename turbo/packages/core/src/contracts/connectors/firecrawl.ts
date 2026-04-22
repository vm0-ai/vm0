import type { ConnectorConfig } from "../connectors";

export const firecrawl = {
  firecrawl: {
    label: "Firecrawl",
    environmentMapping: {
      FIRECRAWL_TOKEN: "$secrets.FIRECRAWL_TOKEN",
    },
    helpText:
      "Connect your Firecrawl account to scrape webpages, crawl websites, and extract structured data",
    authMethods: {
      "api-token": {
        label: "API Token",
        helpText:
          "1. Log in to [Firecrawl](https://www.firecrawl.dev)\n2. Go to your **Dashboard**\n3. Copy your **API Key**",
        secrets: {
          FIRECRAWL_TOKEN: {
            label: "API Token",
            required: true,
            placeholder: "fc-xxxxxxxx",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
