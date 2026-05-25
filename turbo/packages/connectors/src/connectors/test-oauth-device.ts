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
        grant: {
          kind: "device-auth",
          deviceAuthUrl: "/api/test/oauth-provider/device/code",
          tokenUrl: "/api/test/oauth-provider/token",
          client: {
            clientRegistration: "static",
            clientType: "public",
            tokenEndpointAuthMethod: "none",
            clientId: "test-oauth-device-client",
          },
          scopes: ["read"],
        },
        access: {
          kind: "static",
          outputs: {
            TEST_OAUTH_DEVICE_TOKEN: "$secrets.TEST_OAUTH_DEVICE_ACCESS_TOKEN",
          },
        },
        revoke: { kind: "none" },
      },
    },
    defaultAuthMethod: "oauth",
  },
} as const satisfies Record<string, ConnectorConfig>;
