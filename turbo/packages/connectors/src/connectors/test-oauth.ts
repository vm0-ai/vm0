import type {
  ConnectorAuthClientConfig,
  ConnectorAuthCodeGrantConfig,
  ConnectorConfig,
  ConnectorManualGrantConfig,
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
  outputs: {
    accessToken: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
    refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
  },
} as const satisfies ConnectorAuthCodeGrantConfig;

const TEST_OAUTH_API_AUTH_CODE_GRANT = {
  kind: "auth-code",
  scopes: ["read"],
  outputs: {
    initialAccessToken: "$secrets.TEST_OAUTH_API_ACCESS_TOKEN",
    initialRefreshToken: "$secrets.TEST_OAUTH_API_REFRESH_TOKEN",
  },
} as const satisfies ConnectorAuthCodeGrantConfig;

const TEST_OAUTH_API_TOKEN_MANUAL_GRANT = {
  kind: "manual",
  fields: {
    TEST_OAUTH_TOKEN: {
      label: "API Token",
      required: true,
      placeholder: "test-oauth-token",
    },
    TEST_OAUTH_API_TOKEN_INPUT_VAR: {
      label: "Input Variable",
      required: true,
      placeholder: "test-input-variable",
      storage: "variable",
    },
  },
} as const satisfies ConnectorManualGrantConfig;

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
        },
        grant: TEST_OAUTH_AUTH_CODE_GRANT,
        access: {
          kind: "refresh-token",
          inputs: {
            refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
          },
          outputs: {
            accessToken: "$secrets.TEST_OAUTH_ACCESS_TOKEN",
            refreshToken: "$secrets.TEST_OAUTH_REFRESH_TOKEN",
          },
          refreshableSecrets: ["TEST_OAUTH_ACCESS_TOKEN"],
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
            "TEST_OAUTH_API_SECONDARY_TOKEN",
          ],
          variables: ["TEST_OAUTH_API_TENANT_ID"],
        },
        grant: TEST_OAUTH_API_AUTH_CODE_GRANT,
        access: {
          kind: "refresh-token",
          inputs: {
            apiRefreshToken: "$secrets.TEST_OAUTH_API_REFRESH_TOKEN",
            tenantId: "$vars.TEST_OAUTH_API_TENANT_ID",
          },
          outputs: {
            refreshedAccessToken: "$secrets.TEST_OAUTH_API_ACCESS_TOKEN",
            refreshedRefreshToken: "$secrets.TEST_OAUTH_API_REFRESH_TOKEN",
            secondaryToken: "$secrets.TEST_OAUTH_API_SECONDARY_TOKEN",
          },
          refreshableSecrets: ["TEST_OAUTH_API_ACCESS_TOKEN"],
          envBindings: {
            TEST_OAUTH_TOKEN: "$secrets.TEST_OAUTH_API_ACCESS_TOKEN",
          },
        },
        revoke: TEST_OAUTH_REVOKE,
      },
      "api-token": {
        featureFlag: FeatureSwitchKey.TestOauthConnector,
        label: "API Token",
        helpText:
          "Test-only manual method used to exercise refreshable access without a platform auth client.",
        storage: {
          secrets: ["TEST_OAUTH_TOKEN", "TEST_OAUTH_API_TOKEN_ACCESS_TOKEN"],
          variables: ["TEST_OAUTH_API_TOKEN_INPUT_VAR"],
        },
        grant: TEST_OAUTH_API_TOKEN_MANUAL_GRANT,
        access: {
          kind: "refresh-token",
          inputs: {
            inputSecret: "$secrets.TEST_OAUTH_TOKEN",
            inputVariable: "$vars.TEST_OAUTH_API_TOKEN_INPUT_VAR",
          },
          outputs: {
            accessToken: "$secrets.TEST_OAUTH_API_TOKEN_ACCESS_TOKEN",
          },
          refreshableSecrets: ["TEST_OAUTH_API_TOKEN_ACCESS_TOKEN"],
          envBindings: {
            TEST_OAUTH_API_TOKEN: "$secrets.TEST_OAUTH_API_TOKEN_ACCESS_TOKEN",
          },
        },
        revoke: TEST_OAUTH_REVOKE,
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
