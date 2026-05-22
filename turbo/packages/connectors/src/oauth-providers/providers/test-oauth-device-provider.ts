import { defineConnectorOAuthProvider } from "../provider-types";
import {
  pollTestOAuthDeviceAuth,
  startTestOAuthDeviceAuth,
  TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME,
} from "./test-oauth-device";

export const testOauthDeviceProvider = defineConnectorOAuthProvider(
  "test-oauth-device",
  {
    getSecretName: () => {
      return TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME;
    },
    startDeviceAuth: async (args) => {
      const { clientId } = args;
      return await startTestOAuthDeviceAuth({
        clientId,
        scopes: args.scopes,
      });
    },
    pollDeviceAuth: async (args) => {
      const { clientId } = args;
      return await pollTestOAuthDeviceAuth({
        clientId,
        deviceCode: args.deviceCode,
      });
    },
  },
);
