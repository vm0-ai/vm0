import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const googleMaps = {
  "google-maps": {
    label: "Google Maps",
    category: "data-automation-infrastructure",
    helpText:
      "Connect Google Maps Platform to access geocoding, places, directions, and other Maps APIs",
    authMethods: {
      "api-token": {
        featureFlag: FeatureSwitchKey.GoogleMapsConnector,
        label: "API Key",
        helpText:
          "1. Open [Google Cloud Console](https://console.cloud.google.com/google/maps-apis/credentials)\n2. Select or create a project and enable the Maps APIs you need (Geocoding, Places, Directions, etc.)\n3. Go to **APIs & Services -> Credentials** and click **Create credentials -> API key**\n4. Copy the API key (format: `AIza...`) and restrict it to the APIs and referrers/IPs you trust",
        storage: {
          secrets: ["GOOGLE_MAPS_TOKEN"],
          variables: [],
        },
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
          envBindings: {
            GOOGLE_MAPS_TOKEN: "$secrets.GOOGLE_MAPS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      oauth: {
        featureFlag: FeatureSwitchKey.GoogleMapsConnector,
        label: "OAuth (Recommended)",
        helpText:
          "Sign in with Google to grant Google Maps Platform access. Google Cloud IAM and enabled Maps APIs determine which resources and actions are available.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["GOOGLE_MAPS_ACCESS_TOKEN", "GOOGLE_MAPS_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/cloud-platform",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_MAPS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_MAPS_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_MAPS_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_MAPS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_MAPS_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_MAPS_ACCESS_TOKEN"],
          envBindings: {
            GOOGLE_MAPS_TOKEN: "$secrets.GOOGLE_MAPS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
