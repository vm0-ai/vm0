import type { ConnectorConfig } from "../connectors";

export const flightapi = {
  flightapi: {
    label: "FlightAPI",
    category: "data-automation-infrastructure",
    environmentMapping: {
      FLIGHTAPI_TOKEN: "$secrets.FLIGHTAPI_TOKEN",
    },
    helpText:
      "Connect FlightAPI to fetch flight schedules, airport status, fares, and trip data",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Sign in to the [FlightAPI dashboard](https://app.flightapi.io)\n2. Copy your **API key** from the dashboard\n3. FlightAPI embeds the key as the final path segment, e.g. `https://api.flightapi.io/airport/$FLIGHTAPI_TOKEN/...` — the firewall accepts the key on any path under `api.flightapi.io`",
        secrets: {
          FLIGHTAPI_TOKEN: {
            label: "API Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
