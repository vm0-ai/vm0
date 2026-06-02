import type { DeviceAuthConnectorAuthProvider } from "../../types";
import {
  pollTestOAuthDeviceAuth,
  startTestOAuthDeviceAuth,
  TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME,
} from "./test-oauth-device";

export const testOauthDeviceProvider: DeviceAuthConnectorAuthProvider<"test-oauth-device"> =
  {
    grant: {
      kind: "device-auth",
      startDeviceAuth: async (args) => {
        const { clientId } = args;
        return await startTestOAuthDeviceAuth({
          clientId,
          deviceAuthGrant: args.deviceAuthGrant,
          scopes: args.scopes,
        });
      },
      pollDeviceAuth: async (args) => {
        const { clientId } = args;
        return await pollTestOAuthDeviceAuth({
          clientId,
          deviceAuthGrant: args.deviceAuthGrant,
          deviceCode: args.deviceCode,
        });
      },
    },
    access: {
      kind: "none",
      getAccessSecretName: () => {
        return TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME;
      },
    },
    revoke: { kind: "none" },
  };
