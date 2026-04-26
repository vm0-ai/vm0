import type { ConnectorConfig } from "../connectors";

export const scrapeninja = {
  scrapeninja: {
    label: "ScrapeNinja",
    category: "data-automation-infrastructure",
    environmentMapping: {
      SCRAPENINJA_TOKEN: "$secrets.SCRAPENINJA_TOKEN",
    },
    helpText:
      "Connect your ScrapeNinja account to scrape web pages with Chrome TLS fingerprint and JS rendering",
    authMethods: {
      "api-token": {
        label: "API Token",
        secrets: {
          SCRAPENINJA_TOKEN: {
            label: "API Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
