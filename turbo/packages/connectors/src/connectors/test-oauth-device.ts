import type { ConnectorConfig } from "../connectors";
import { FeatureSwitchKey } from "../feature-switch-key";

export const testOauthDevice = {
  "test-oauth-device": {
    label: "Test OAuth Device (internal)",
    category: "data-automation-infrastructure",
    environmentMapping: {
      TEST_OAUTH_DEVICE_TOKEN: "$secrets.TEST_OAUTH_DEVICE_ACCESS_TOKEN",
    },
    helpText:
      "Synthetic OAuth 2.0 device authorization connector. For automated tests only.",
    authMethods: {
      oauth: {
        featureFlag: FeatureSwitchKey.TestOauthConnector,
        label: "OAuth Device Authorization",
        helpText: "Test-only OAuth device provider.",
        secrets: {
          TEST_OAUTH_DEVICE_ACCESS_TOKEN: {
            label: "Access Token",
            required: true,
          },
        },
      },
    },
    defaultAuthMethod: "oauth",
    oauth: {
      flow: "device-authorization",
      deviceAuthorizationUrl: "https://oauth-device.test/device/code",
      tokenUrl: "https://oauth-device.test/token",
      client: {
        clientRegistration: "static",
        clientType: "public",
        tokenEndpointAuthMethod: "none",
        clientId: "test-oauth-device-client",
      },
      scopes: ["read"],
    },
  },
} as const satisfies Record<string, ConnectorConfig>;
