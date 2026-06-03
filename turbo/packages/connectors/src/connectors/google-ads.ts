import type { ConnectorConfig } from "../connectors";

export const googleAds = {
  "google-ads": {
    label: "Google Ads",
    category: "marketing-content-growth",
    tags: ["ads", "advertising", "google ads", "campaigns", "gaql"],
    helpText:
      "Connect your Google Ads account to manage campaigns, ad groups, and performance reports",
    authMethods: {
      oauth: {
        showExperimentalLabel: false,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Ads access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["GOOGLE_ADS_ACCESS_TOKEN", "GOOGLE_ADS_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/adwords",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_ADS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_ADS_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_ADS_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_ADS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_ADS_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_ADS_ACCESS_TOKEN"],
          platformSecrets: ["GOOGLE_ADS_DEVELOPER_TOKEN"],
          envBindings: {
            GOOGLE_ADS_TOKEN: "$secrets.GOOGLE_ADS_ACCESS_TOKEN",
            GOOGLE_ADS_DEVELOPER_TOKEN: "$secrets.GOOGLE_ADS_DEVELOPER_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
