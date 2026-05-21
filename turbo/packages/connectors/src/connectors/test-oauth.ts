import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const testOauth = {
  "test-oauth": {
    label: "Test OAuth (internal)",
    category: "data-automation-infrastructure",
    environmentMapping: {
      TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
    },
    helpText:
      "Synthetic OAuth 2.0 connector served by this app itself. For automated tests only — not a real third-party service.",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.TestOauthConnector,
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
      flow: "authorization-code",
      // Relative path — the provider resolves it against the concrete app/API
      // URL at call time because the fake provider lives inside this same app
      // and the preview-URL host changes per deploy.
      tokenUrl: "/api/test/oauth-provider/token",
      client: {
        clientRegistration: "static",
        clientType: "confidential",
        tokenEndpointAuthMethod: "client_secret_post",
        clientId: "test-oauth-client",
        clientSecret: "test-oauth-secret",
      },
      scopes: ["read"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
