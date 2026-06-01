import type {
  ConnectorAuthClientConfig,
  ConnectorAuthCodeGrantConfig,
  ConnectorConfig,
  ConnectorRevokeConfig,
} from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

const OAUTH_TOKEN_URL = "/api/test/oauth-provider/token";

const TEST_OAUTH_CLIENT = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-oauth-client",
  clientSecret: "test-oauth-secret",
} satisfies ConnectorAuthClientConfig;

const TEST_OAUTH_AUTH_CODE_GRANT = {
  kind: "auth-code",
  tokenUrl: OAUTH_TOKEN_URL,
  scopes: ["read"],
} satisfies ConnectorAuthCodeGrantConfig;

const TEST_OAUTH_REVOKE = { kind: "none" } satisfies ConnectorRevokeConfig;

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
        client: TEST_OAUTH_CLIENT,
        grant: TEST_OAUTH_AUTH_CODE_GRANT,
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          accessToken: "TEST_OAUTH_ACCESS_TOKEN",
          refreshToken: "TEST_OAUTH_REFRESH_TOKEN",
          envBindings: {
            TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
          },
        },
        revoke: TEST_OAUTH_REVOKE,
      },
      api: {
        featureFlag: FeatureSwitchKey.TestOauthConnector,
        label: "API OAuth",
        helpText:
          "Secondary test-only OAuth method used to exercise method-aware provider registration.",
        client: TEST_OAUTH_CLIENT,
        grant: TEST_OAUTH_AUTH_CODE_GRANT,
        access: {
          kind: "refresh-token",
          tokenUrl: OAUTH_TOKEN_URL,
          accessToken: "TEST_OAUTH_API_ACCESS_TOKEN",
          refreshToken: "TEST_OAUTH_API_REFRESH_TOKEN",
          envBindings: {
            TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_API_ACCESS_TOKEN",
          },
        },
        revoke: TEST_OAUTH_REVOKE,
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
