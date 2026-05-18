import type { ConnectorConfig } from "../connectors";

export const aviationstack = {
  aviationstack: {
    label: "AviationStack",
    category: "data-automation-infrastructure",
    environmentMapping: {
      AVIATIONSTACK_TOKEN: "$secrets.AVIATIONSTACK_TOKEN",
    },
    helpText:
      "Connect AviationStack to access real-time flight status, schedules, airline, airport, and route data",
    authMethods: {
      "api-token": {
        label: "Access Key",
        helpText:
          "1. Sign in to the [AviationStack dashboard](https://aviationstack.com/dashboard)\n2. Copy the **API Access Key** shown on the main dashboard\n3. Pass it as the `access_key` query parameter on every request",
        secrets: {
          AVIATIONSTACK_TOKEN: {
            label: "Access Key",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
