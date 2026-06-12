import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const googleAnalytics = {
  "google-analytics": {
    label: "Google Analytics",
    category: "marketing-content-growth",
    tags: [
      "analytics",
      "ga4",
      "reports",
      "traffic",
      "properties",
      "admin api",
      "data api",
    ],
    helpText:
      "Connect your Google account to access GA4 reports, properties, accounts, and audience data",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.GoogleAnalyticsConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with Google to grant Google Analytics access.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: [
            "GOOGLE_ANALYTICS_ACCESS_TOKEN",
            "GOOGLE_ANALYTICS_REFRESH_TOKEN",
          ],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "https://www.googleapis.com/auth/analytics.readonly",
            "https://www.googleapis.com/auth/analytics.edit",
            "https://www.googleapis.com/auth/userinfo.email",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_ANALYTICS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_ANALYTICS_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_ANALYTICS_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_ANALYTICS_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_ANALYTICS_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_ANALYTICS_ACCESS_TOKEN"],
          envBindings: {
            GOOGLE_ANALYTICS_TOKEN: "$secrets.GOOGLE_ANALYTICS_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
