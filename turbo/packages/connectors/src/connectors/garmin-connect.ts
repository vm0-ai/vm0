import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const garminConnect = {
  "garmin-connect": {
    label: "Garmin Connect",
    category: "data-automation-infrastructure",
    environmentMapping: {
      GARMIN_CONNECT_TOKEN: "$secrets.GARMIN_CONNECT_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Garmin Connect account to access wellness and activity data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.GarminConnectConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Garmin Connect to grant access.",
        secrets: {
          GARMIN_CONNECT_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GARMIN_CONNECT_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://connect.garmin.com/oauth2Confirm",
      tokenUrl: "https://diauth.garmin.com/di-oauth2-service/oauth/token",
      scopes: [],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
