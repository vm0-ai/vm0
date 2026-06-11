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
        showExperimentalLabel: false,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Facebook to grant access to Ads Manager.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "META_ADS_OAUTH_CLIENT_ID",
          clientSecretEnv: "META_ADS_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["META_ADS_ACCESS_TOKEN", "META_ADS_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "ads_management",
            "ads_read",
            "business_management",
            "pages_manage_ads",
            "pages_read_engagement",
            "pages_show_list",
            "public_profile",
          ],
          outputs: {
            accessToken: "$secrets.META_ADS_ACCESS_TOKEN",
            refreshToken: "$secrets.META_ADS_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.META_ADS_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.META_ADS_ACCESS_TOKEN",
            refreshToken: "$secrets.META_ADS_REFRESH_TOKEN",
          },
          refreshableSecrets: ["META_ADS_ACCESS_TOKEN"],
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
