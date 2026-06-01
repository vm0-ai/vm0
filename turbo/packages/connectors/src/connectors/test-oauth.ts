import type { ConnectorAuthMethodConfig, ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

const OAUTH_TOKEN_URL = "/api/test/oauth-provider/token";

const testOauthAuthMethod = {
  featureFlag: FeatureSwitchKey.TestOauthConnector,
  label: "OAuth",
  helpText: "Test-only OAuth provider. Only reachable in dev/preview.",
  client: {
    clientRegistration: "static",
    clientType: "confidential",
    clientId: "test-oauth-client",
    clientSecret: "test-oauth-secret",
  },
  grant: {
    kind: "auth-code",
    tokenUrl: OAUTH_TOKEN_URL,
    scopes: ["read"],
  },
  access: {
    kind: "refresh-token",
    tokenUrl: OAUTH_TOKEN_URL,
    accessToken: "TEST_OAUTH_ACCESS_TOKEN",
    refreshToken: "TEST_OAUTH_REFRESH_TOKEN",
    envBindings: {
      TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
    },
  },
  revoke: { kind: "none" },
} satisfies ConnectorAuthMethodConfig;

export const testOauth = {
  "test-oauth": {
    label: "Test OAuth (internal)",
    category: "data-automation-infrastructure",
    helpText:
      "Synthetic OAuth 2.0 connector served by this app itself. For automated tests only — not a real third-party service.",
    authMethods: {
      oauth: testOauthAuthMethod,
      api: {
        ...testOauthAuthMethod,
        label: "API OAuth",
        helpText:
          "Secondary test-only OAuth method used to exercise method-aware provider registration.",
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          accessToken: "TEST_OAUTH_API_ACCESS_TOKEN",
          refreshToken: "TEST_OAUTH_API_REFRESH_TOKEN",
          envBindings: {
            TEST_OAUTH_API_TOKEN: "$secrets.TEST_OAUTH_API_ACCESS_TOKEN",
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
