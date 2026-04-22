import { FeatureSwitchKey } from "../../feature-switch-key";
import type { ConnectorConfig } from "../connectors";

export const testOauth = {
  "test-oauth": {
    label: "Test OAuth (internal)",
    featureFlag: FeatureSwitchKey.TestOauthConnector,
    environmentMapping: {
      TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
    },
    helpText:
      "Synthetic OAuth 2.0 connector served by this app itself. For automated tests only — not a real third-party service.",
    authMethods: {
      oauth: {
        label: "OAuth",
        helpText: "Test-only OAuth provider. Only reachable in dev/preview.",
        secrets: {
          TEST_OAUTH_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
          TEST_OAUTH_REFRESH_TOKEN: {
            label: "Refresh Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      // Relative paths — the handler resolves them against NEXT_PUBLIC_APP_URL
      // at call time because the fake provider lives inside this same app and
      // the preview-URL host changes per deploy.
      authorizationUrl: "/api/test/oauth-provider/authorize",
      tokenUrl: "/api/test/oauth-provider/token",
      scopes: ["read"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
