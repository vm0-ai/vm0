import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const testOauthDevice = {
  "test-oauth-device": {
    label: "Test OAuth Device (internal)",
    category: "data-automation-infrastructure",
    helpText:
      "Synthetic OAuth 2.0 device authorization connector. For automated tests only.",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.TestOauthConnector,
        label: "OAuth Device Authorization",
        helpText: "Test-only OAuth device provider.",
        client: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "test-oauth-device-client",
        },
        storage: {
          secrets: ["TEST_OAUTH_DEVICE_ACCESS_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "device-auth",
          scopes: ["read"],
          outputs: {
            accessToken: "$secrets.TEST_OAUTH_DEVICE_ACCESS_TOKEN",
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TEST_OAUTH_DEVICE_TOKEN: "$secrets.TEST_OAUTH_DEVICE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
      api: {
        featureFlag: FeatureSwitchKey.TestOauthConnector,
        label: "API Device Authorization",
        helpText:
          "Secondary test-only OAuth device method used to exercise method-aware device authorization sessions.",
        client: {
          clientRegistration: "static",
          clientType: "public",
          clientId: "test-oauth-device-api-client",
        },
        storage: {
          secrets: ["TEST_OAUTH_DEVICE_API_ACCESS_TOKEN"],
          variables: [],
        },
        grant: {
          kind: "device-auth",
          scopes: ["read"],
          outputs: {
            accessToken: "$secrets.TEST_OAUTH_DEVICE_API_ACCESS_TOKEN",
          },
        },
        access: {
          kind: "static",
          envBindings: {
            TEST_OAUTH_DEVICE_API_TOKEN:
              "$secrets.TEST_OAUTH_DEVICE_API_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
