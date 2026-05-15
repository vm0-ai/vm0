import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const posthog = {
  posthog: {
    label: "PostHog",
    category: "data-automation-infrastructure",
    environmentMapping: {
      POSTHOG_TOKEN: "$secrets.POSTHOG_ACCESS_TOKEN",
    },
    helpText:
      "Connect your PostHog account to access product analytics, feature flags, and experiments",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.PosthogConnector,
        label: "OAuth (Recommended)",
        helpText: "Sign in with PostHog to grant access.",
        secrets: {
          POSTHOG_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          POSTHOG_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
      "api-token": {
        label: "Personal API Key",
        helpText:
          "1. Log in to [PostHog](https://app.posthog.com)\n2. Navigate to **Personal API keys** in your account settings\n3. Click **+ Create a personal API Key**\n4. Enter a descriptive label for the key\n5. Choose the scopes (permissions) required for your use case\n6. Copy the key immediately (it will not be shown again after refreshing the page)",
        secrets: {
          POSTHOG_TOKEN: {
            label: "Personal API Key",
            required: true,
            placeholder: "phx_...",
          },
        },
      },
    },
    defaultAuthMethod: "api-token",
    oauth: {
      authorizationUrl: "https://us.posthog.com/oauth/authorize",
      tokenUrl: "https://us.posthog.com/oauth/token",
      scopes: [
        "openid",
        "profile",
        "email",
        "user:read",
        "project:read",
        "feature_flag:read",
        "feature_flag:write",
        "experiment:read",
        "experiment:write",
        "insight:read",
        "insight:write",
        "dashboard:read",
        "dashboard:write",
        "action:read",
        "action:write",
        "annotation:read",
        "annotation:write",
        "cohort:read",
        "cohort:write",
        "event_definition:read",
        "query:read",
        "survey:read",
        "survey:write",
        "error_tracking:read",
      ],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
