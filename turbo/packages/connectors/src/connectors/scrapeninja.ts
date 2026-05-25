import type { ConnectorConfig } from "../connectors";

export const scrapeninja = {
  scrapeninja: {
    label: "ScrapeNinja",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your ScrapeNinja account to scrape web pages with Chrome TLS fingerprint and JS rendering",
    authMethods: {
      "api-token": {
        label: "API Token",
        grant: {
          kind: "manual",
          fields: {
            SCRAPENINJA_TOKEN: {
              label: "API Token",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            SCRAPENINJA_TOKEN: "$secrets.SCRAPENINJA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
