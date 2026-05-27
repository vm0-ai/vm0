import type { ConnectorConfig } from "../connectors";

export const flightaware = {
  flightaware: {
    label: "FlightAware",
    category: "data-automation-infrastructure",
    helpText:
      "Connect FlightAware AeroAPI to access flight status, airport, airline, and aviation data",
    authMethods: {
      "api-token": {
        label: "AeroAPI Key",
        helpText:
          "1. Sign in to the [FlightAware AeroAPI portal](https://flightaware.com/aeroapi/portal/)\n2. Open your API key settings\n3. Copy your AeroAPI key\n4. Send it in the `x-apikey` header for AeroAPI requests",
        grant: {
          kind: "manual",
          fields: {
            FLIGHTAWARE_TOKEN: {
              label: "AeroAPI Key",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            FLIGHTAWARE_TOKEN: "$secrets.FLIGHTAWARE_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
