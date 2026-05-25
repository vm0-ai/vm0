import type { ConnectorConfig } from "../connectors";

export const rentcast = {
  rentcast: {
    label: "RentCast",
    category: "data-automation-infrastructure",
    environmentMapping: {
      RENTCAST_API_KEY: "$secrets.RENTCAST_API_KEY",
    },
    helpText:
      "Connect your RentCast account to retrieve US property records, listings, valuations, rent estimates, and market data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Log in to the [RentCast API dashboard](https://app.rentcast.io/app/api)\n2. Click **Create API Key**\n3. Copy the generated API key",
        secrets: {
          RENTCAST_API_KEY: {
            label: "API Key",
            required: true,
            placeholder: "your-rentcast-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
