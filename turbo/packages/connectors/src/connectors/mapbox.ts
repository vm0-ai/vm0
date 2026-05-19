import type { ConnectorConfig } from "../connectors";

export const mapbox = {
  mapbox: {
    label: "Mapbox",
    category: "data-automation-infrastructure",
    environmentMapping: {
      MAPBOX_TOKEN: "$secrets.MAPBOX_TOKEN",
    },
    helpText:
      "Connect Mapbox to access geocoding, directions, isochrones, and other location APIs",
    authMethods: {
      "api-token": {
        label: "Access Token",
        helpText:
          "1. Log in to [Mapbox](https://account.mapbox.com)\n2. Open the **Access tokens** page\n3. Click **Create a token**, give it a name, and pick the scopes you need\n4. Copy the token (format: `pk.…`) — pass it as the `access_token` query parameter",
        secrets: {
          MAPBOX_TOKEN: {
            label: "Access Token",
            required: true,
            placeholder: "pk....",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
