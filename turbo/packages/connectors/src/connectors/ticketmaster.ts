import type { ConnectorConfig } from "../connectors";

export const ticketmaster = {
  ticketmaster: {
    label: "Ticketmaster",
    category: "data-automation-infrastructure",
    environmentMapping: {
      TICKETMASTER_API_KEY: "$secrets.TICKETMASTER_API_KEY",
    },
    helpText:
      "Connect Ticketmaster to search events, attractions, venues, and classifications with the Discovery API",
    authMethods: {
      "api-token": {
        label: "Discovery API Key",
        helpText:
          "1. Log in to the [Ticketmaster Developer Portal](https://developer.ticketmaster.com)\n2. Open your application in **My Apps**\n3. Copy the **Consumer Key** for the Discovery API\n4. Use it as the `apikey` query parameter for Discovery API requests",
        secrets: {
          TICKETMASTER_API_KEY: {
            label: "Discovery API Key",
            required: true,
            placeholder: "your-ticketmaster-api-key",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
