import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const googleAds = {
  "google-ads": {
    label: "Google Ads",
    category: "marketing-content-growth",
    tags: ["ads", "advertising", "google ads", "campaigns", "gaql"],
    environmentMapping: {
      GOOGLE_ADS_TOKEN: "$secrets.GOOGLE_ADS_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Google Ads account to manage campaigns, ad groups, and performance reports",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.GoogleAdsConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Ads access.",
        secrets: {
          GOOGLE_ADS_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          GOOGLE_ADS_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
        clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
      },
      scopes: [
        "https://www.googleapis.com/auth/adwords",
        "https://www.googleapis.com/auth/userinfo.email",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
