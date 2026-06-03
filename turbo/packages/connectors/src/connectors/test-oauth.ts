import type {
  ConnectorAuthClientConfig,
  ConnectorAuthCodeGrantConfig,
  ConnectorConfig,
  ConnectorRevokeConfig,
} from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

const TEST_OAUTH_CLIENT = {
  clientRegistration: "static",
  clientType: "confidential",
  clientId: "test-oauth-client",
  clientSecret: "test-oauth-secret",
} satisfies ConnectorAuthClientConfig;

const TEST_OAUTH_AUTH_CODE_GRANT = {
  kind: "auth-code",
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
        storage: {
          secrets: ["TEST_OAUTH_ACCESS_TOKEN", "TEST_OAUTH_REFRESH_TOKEN"],
          variables: [],
          secretRoles: {
            accessToken: "TEST_OAUTH_ACCESS_TOKEN",
            refreshToken: "TEST_OAUTH_REFRESH_TOKEN",
          },
        },
        grant: TEST_OAUTH_AUTH_CODE_GRANT,
        access: {
          kind: "refresh-token",
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
        storage: {
          secrets: [
            "TEST_OAUTH_API_ACCESS_TOKEN",
            "TEST_OAUTH_API_REFRESH_TOKEN",
          ],
          variables: [],
          secretRoles: {
            accessToken: "TEST_OAUTH_API_ACCESS_TOKEN",
            refreshToken: "TEST_OAUTH_API_REFRESH_TOKEN",
          },
        },
        grant: TEST_OAUTH_AUTH_CODE_GRANT,
        access: {
          kind: "refresh-token",
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
