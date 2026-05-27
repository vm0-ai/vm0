import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const metaAds = {
  "meta-ads": {
    label: "Meta Ads",
    category: "marketing-content-growth",
    helpText:
      "Connect your Meta Ads Manager account to manage ad campaigns, audiences, and insights",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.MetaAdsConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Facebook to grant access to Ads Manager.",
        grant: {
          kind: "auth-code",
          tokenUrl: "https://graph.facebook.com/v22.0/oauth/access_token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientIdEnv: "META_ADS_OAUTH_CLIENT_ID",
            clientSecretEnv: "META_ADS_OAUTH_CLIENT_SECRET",
          },
          scopes: ["ads_management", "ads_read", "business_management"],
        },
        access: {
          kind: "static",
          envBindings: {
            META_ADS_TOKEN: "$secrets.META_ADS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
