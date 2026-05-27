import type { ConnectorConfig } from "../connectors";

export const amadeus = {
  amadeus: {
    label: "Amadeus",
    category: "data-automation-infrastructure",
    helpText:
      "Connect Amadeus for Developers to search flights, hotels, destinations, and travel data",
    authMethods: {
      "api-token": {
        label: "API Key and Secret",
        helpText:
          "1. Sign in to the [Amadeus for Developers portal](https://developers.amadeus.com/)\n2. Create or open an app in **My Self-Service Workspace**\n3. Copy the app's **API Key** and **API Secret**\n4. Use them with the client credentials grant to request an access token",
        grant: {
          kind: "manual",
          fields: {
            AMADEUS_API_KEY: {
              label: "API Key",
              required: true,
            },
            AMADEUS_API_SECRET: {
              label: "API Secret",
              required: true,
            },
          },
        },
        access: {
          kind: "static",
          envBindings: {
            AMADEUS_API_KEY: "$secrets.AMADEUS_API_KEY",
            AMADEUS_API_SECRET: "$secrets.AMADEUS_API_SECRET",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
