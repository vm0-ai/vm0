import { defineConnectorOAuthProvider } from "../provider-types";
import {
  pollTestOAuthDeviceAuthorization,
  startTestOAuthDeviceAuthorization,
  TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME,
} from "./test-oauth-device";

export const testOauthDeviceProvider = defineConnectorOAuthProvider(
  "test-oauth-device",
  {
    getSecretName: () => {
      return TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME;
    },
    startDeviceAuthorization: async (args) => {
      const { clientId } = args;
      return await startTestOAuthDeviceAuthorization({
        clientId,
        scopes: args.scopes,
      });
    },
    pollDeviceAuthorization: async (args) => {
      const { clientId } = args;
      return await pollTestOAuthDeviceAuthorization({
        clientId,
        deviceCode: args.deviceCode,
      });
    },
  },
);
