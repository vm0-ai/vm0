import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const googleCloud = {
  "google-cloud": {
    label: "Google Cloud",
    category: "data-automation-infrastructure",
    tags: [
      "google cloud",
      "gcp",
      "cloud",
      "bigquery",
      "cloud storage",
      "cloud run",
    ],
    helpText:
      "Connect your Google account to access Google Cloud resources through Google Cloud APIs. Google IAM and enabled APIs determine which projects, resources, and actions are available.",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.GoogleCloudConnector,
        label: "OAuth (Recommended)",
        helpText:
          "Sign in with Google to grant Google Cloud access. The connector is not bound to one project; Google IAM controls accessible resources.",
        client: {
          clientRegistration: "static",
          clientType: "confidential",
          clientIdEnv: "GOOGLE_OAUTH_CLIENT_ID",
          clientSecretEnv: "GOOGLE_OAUTH_CLIENT_SECRET",
        },
        storage: {
          secrets: ["GOOGLE_CLOUD_ACCESS_TOKEN", "GOOGLE_CLOUD_REFRESH_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "auth-code",
          scopes: [
            "openid",
            "https://www.googleapis.com/auth/userinfo.email",
            "https://www.googleapis.com/auth/cloud-platform",
            "https://www.googleapis.com/auth/appengine.admin",
            "https://www.googleapis.com/auth/sqlservice.login",
            "https://www.googleapis.com/auth/compute",
          ],
          outputs: {
            accessToken: "$secrets.GOOGLE_CLOUD_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_CLOUD_REFRESH_TOKEN",
          },
        },
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.GOOGLE_CLOUD_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.GOOGLE_CLOUD_ACCESS_TOKEN",
            refreshToken: "$secrets.GOOGLE_CLOUD_REFRESH_TOKEN",
          },
          refreshableSecrets: ["GOOGLE_CLOUD_ACCESS_TOKEN"],
          envBindings: {
            GOOGLE_CLOUD_TOKEN: "$secrets.GOOGLE_CLOUD_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
