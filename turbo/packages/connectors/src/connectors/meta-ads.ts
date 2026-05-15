import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const metaAds = {
  "meta-ads": {
    label: "Meta Ads",
    category: "marketing-content-growth",
    environmentMapping: {
      META_ADS_TOKEN: "$secrets.META_ADS_ACCESS_TOKEN",
    },
    helpText:
      "Connect your Meta Ads Manager account to manage ad campaigns, audiences, and insights",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.MetaAdsConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Facebook to grant access to Ads Manager.",
        secrets: {
          META_ADS_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      authorizationUrl: "https://www.facebook.com/v22.0/dialog/oauth",
      tokenUrl: "https://graph.facebook.com/v22.0/oauth/access_token",
      scopes: ["ads_management", "ads_read", "business_management"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
