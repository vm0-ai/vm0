import type { ConnectorConfig } from "../connectors";

export const rentcast = {
  rentcast: {
    label: "RentCast",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your RentCast account to retrieve US property records, listings, valuations, rent estimates, and market data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [RentCast API dashboard](https://app.rentcast.io/app/api)\n2. Click **Create API Key**\n3. Copy the generated API key",
        storage: {
          secrets: ["RENTCAST_API_KEY"],
          variables: [],
        },
        grant: {
          kind: "manual",
          fields: {
            RENTCAST_API_KEY: {
              label: "API Key",
              required: true,
              placeholder: "your-rentcast-api-key",
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            RENTCAST_API_KEY: "$secrets.RENTCAST_API_KEY",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
