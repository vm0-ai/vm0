import type { ConnectorConfig } from "../connectors";

export const bubblemaps = {
  bubblemaps: {
    label: "Bubblemaps",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Bubblemaps account to access token maps, holders, wallet labels, clusters, and scores through the Data API",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [Bubblemaps Pro platform](https://pro.bubblemaps.io)\n2. Get your Data API key\n3. Use this key in the `X-ApiKey` request header",
        storage: {
          secrets: ["BUBBLEMAPS_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            BUBBLEMAPS_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "Coffee5afe10ca1Coffee5afe10ca1Co",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            BUBBLEMAPS_API_KEY: "$secrets.BUBBLEMAPS_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
