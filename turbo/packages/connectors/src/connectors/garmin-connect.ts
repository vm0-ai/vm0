import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

const OAUTH_TOKEN_URL =
  "https://diauth.garmin.com/di-oauth2-service/oauth/token";

export const garminConnect = {
  "garmin-connect": {
    label: "Garmin Connect",
    category: "data-automation-infrastructure",
    helpText:
      "Connect your Garmin Connect account to access wellness and activity data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.GarminConnectConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Garmin Connect to grant access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GARMIN_CONNECT_OAUTH_CLIENT_ID",
          clientSecretEnv: "GARMIN_CONNECT_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: [
            "GARMIN_CONNECT_ACCESS_TOKEN",
            "GARMIN_CONNECT_REFRESH_TOKEN",
          ],
          variables: [],
          secretRoles: {
            accessToken: "GARMIN_CONNECT_ACCESS_TOKEN",
            refreshToken: "GARMIN_CONNECT_REFRESH_TOKEN",
          },
        },
        grant: {
          kind: "auth-code",
          tokenUrl: OAUTH_TOKEN_URL,
          scopes: [],
        },
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          envBindings: {
            GARMIN_CONNECT_TOKEN: "$secrets.GARMIN_CONNECT_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
