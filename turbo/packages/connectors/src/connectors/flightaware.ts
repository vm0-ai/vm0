import type { ConnectorConfig } from "../connectors";

export const flightaware = {
  flightaware: {
    label: "FlightAware",
    category: "data-automation-infrastructure",
    environmentMapping: {
      FLIGHTAWARE_TOKEN: "$secrets.FLIGHTAWARE_TOKEN",
    },
    helpText:
      "Connect FlightAware AeroAPI to access flight status, airport, airline, and aviation data",
    authMethods: {
      "api-token": {
        label: "AeroAPI Key",
        helpText:
          "1. Sign in to the [FlightAware AeroAPI portal](https://flightaware.com/aeroapi/portal/)\n2. Open your API key settings\n3. Copy your AeroAPI key\n4. Send it in the `x-apikey` header for AeroAPI requests",
        secrets: {
          FLIGHTAWARE_TOKEN: {
            label: "AeroAPI Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
