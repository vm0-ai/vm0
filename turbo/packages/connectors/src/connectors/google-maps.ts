import type { ConnectorConfig } from "../connectors";

export const googleMaps = {
  "google-maps": {
    label: "Google Maps",
    category: "data-automation-infrastructure",
    helpText:
      "Connect Google Maps Platform to access geocoding, places, directions, and route matrices",
    authMethods: {
      oauth: {
        showExperimentalLabel: false,
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
