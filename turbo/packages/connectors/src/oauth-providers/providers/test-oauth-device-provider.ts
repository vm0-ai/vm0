import { defineConnectorOAuthProvider } from "../provider-types";

export const TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME =
  "TEST_OAUTH_DEVICE_ACCESS_TOKEN";

export const testOauthDeviceProvider = defineConnectorOAuthProvider(
  "test-oauth-device",
  {
    getSecretName: () => {
      return TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME;
    },
    startDeviceAuthorization: async (args) => {
      return {
        deviceCode: `test-device:${args.clientId}:${args.scopes.join(",")}`,
        userCode: "TEST-DEVICE",
        verificationUri: "https://oauth-device.test/device",
        verificationUriComplete:
          "https://oauth-device.test/device?user_code=TEST-DEVICE",
        expiresIn: 600,
        interval: 5,
      };
    },
    pollDeviceAuthorization: async (args) => {
      switch (args.deviceCode) {
        case "pending": {
          return { status: "pending" };
        }
        case "slow-down": {
          return { status: "pending", interval: 10 };
        }
        case "denied": {
          return {
            status: "denied",
            error: "access_denied",
            errorDescription: "User denied the device authorization request",
          };
        }
        case "expired": {
          return {
            status: "expired",
            error: "expired_token",
            errorDescription: "Device authorization expired",
          };
        }
        case "error": {
          return {
            status: "error",
            error: "invalid_request",
            errorDescription: "Synthetic device authorization error",
          };
        }
        default: {
          return {
            status: "complete",
            token: {
              accessToken: `test-device-access:${args.clientId}:${args.deviceCode}`,
              refreshToken: null,
              scopes: ["read"],
              userInfo: {
                id: "test-oauth-device-user",
                username: "test-oauth-device-user",
                email: "test-oauth-device@example.com",
              },
            },
          };
        }
      }
    },
  },
);
