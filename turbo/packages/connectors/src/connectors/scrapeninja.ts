import type { ConnectorConfig } from "../connector-config";

export const scrapeninja = {
  scrapeninja: {
    label: "ScrapeNinja",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your ScrapeNinja account to scrape web pages with Chrome TLS fingerprint and JS rendering",
    authMethods: {
      "api-token": {
        label: "RapidAPI Key",
        storage: {
          secrets: ["SCRAPENINJA_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            SCRAPENINJA_TOKEN: {
              label: "RapidAPI Key",
              publicId: "apiKey",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            SCRAPENINJA_TOKEN: "$secrets.SCRAPENINJA_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
