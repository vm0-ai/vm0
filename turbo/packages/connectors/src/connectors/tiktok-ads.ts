import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const tiktokAds = {
  "tiktok-ads": {
    label: "TikTok Ads",
    category: "marketing-content-growth",
    tags: ["ads", "advertising", "tiktok ads", "campaigns", "reporting"],
    helpText:
      "Connect your TikTok Ads Manager account to manage ad campaigns, ad groups, ads, and performance reports",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.TikTokAdsConnector,
        showExperimentalLabel: false,
        label: "OAuth (Recommended)",
        helpText: "Sign in with TikTok for Business to grant Ads access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "TIKTOK_ADS_OAUTH_CLIENT_ID",
          clientSecretEnv: "TIKTOK_ADS_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["TIKTOK_ADS_ACCESS_TOKEN", "TIKTOK_ADS_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [],
          outputs: {
            accessToken: "$secrets.TIKTOK_ADS_ACCESS_TOKEN",
            refreshToken: "$secrets.TIKTOK_ADS_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.TIKTOK_ADS_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.TIKTOK_ADS_ACCESS_TOKEN",
            refreshToken: "$secrets.TIKTOK_ADS_REFRESH_TOKEN",
          },
          refreshableSecrets: ["TIKTOK_ADS_ACCESS_TOKEN"],
          envBindings: {
            TIKTOK_ADS_TOKEN: "$secrets.TIKTOK_ADS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
