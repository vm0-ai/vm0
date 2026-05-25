import type { ConnectorConfig } from "../connectors";

export const googleMaps = {
  "google-maps": {
    label: "Google Maps",
    category: "data-automation-infrastructure",
    helpText:
      "Connect Google Maps Platform to access geocoding, places, directions, and other Maps APIs",
    authMethods: {
      "api-token": {
        label: "API Key",
        helpText:
          "1. Open [Google Cloud Console](https://console.cloud.google.com/google/maps-apis/credentials)\n2. Select or create a project and enable the Maps APIs you need (Geocoding, Places, Directions, etc.)\n3. Go to **APIs & Services → Credentials** and click **Create credentials → API key**\n4. Copy the API key (format: `AIza…`) and restrict it to the APIs and referrers/IPs you trust",
        grant: {
          kind: "manual",
          fields: {
            GOOGLE_MAPS_TOKEN: {
              label: "API Key",
              required: true,
              placeholder: "AIza...",
            },
          },
        },
        access: {
          kind: "static",
          outputs: {
            GOOGLE_MAPS_TOKEN: "$secrets.GOOGLE_MAPS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "api-token",
  },
} as const satisfies Record<string, ConnectorConfig>;
