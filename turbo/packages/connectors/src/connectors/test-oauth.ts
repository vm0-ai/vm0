import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const testOauth = {
  "test-oauth": {
    label: "Test OAuth (internal)",
    category: "data-automation-infrastructure",
    helpText:
      "Synthetic OAuth 2.0 connector served by this app itself. For automated tests only — not a real third-party service.",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.TestOauthConnector,
        label: "OAuth",
        helpText: "Test-only OAuth provider. Only reachable in dev/preview.",
        grant: {
          kind: "auth-code",
          tokenUrl: "/api/test/oauth-provider/token",
          client: {
            clientRegistration: "static",
            clientType: "confidential",
            clientId: "test-oauth-client",
            clientSecret: "test-oauth-secret",
          },
          scopes: ["read"],
        },
        access: {
          kind: "refresh-token",
          accessToken: "TEST_OAUTH_ACCESS_TOKEN",
          refreshToken: "TEST_OAUTH_REFRESH_TOKEN",
          outputs: {
            TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
