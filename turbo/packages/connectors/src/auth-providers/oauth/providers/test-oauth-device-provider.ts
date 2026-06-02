import type {
  DeviceAuthConnectorAuthProvider,
  DeviceAuthGrantProvider,
} from "../../types";
import type { ConnectorDeviceAuthGrantAuthMethodId } from "../../../connectors";
import {
  pollTestOAuthDeviceAuth,
  TEST_OAUTH_DEVICE_API_ACCESS_SECRET_NAME,
  startTestOAuthDeviceAuth,
  TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME,
} from "./test-oauth-device";

function createTestOauthDeviceGrant<
  Method extends ConnectorDeviceAuthGrantAuthMethodId<"test-oauth-device">,
>(): DeviceAuthGrantProvider<"test-oauth-device", Method> {
  return {
    kind: "device-auth",
    startDeviceAuth: async (args) => {
      const { clientId } = args.authClient;
      return await startTestOAuthDeviceAuth({
        clientId,
        deviceAuthGrant: args.deviceAuthGrant,
        scopes: args.scopes,
      });
    },
    pollDeviceAuth: async (args) => {
      const { clientId } = args.authClient;
      return await pollTestOAuthDeviceAuth({
        clientId,
        deviceAuthGrant: args.deviceAuthGrant,
        deviceCode: args.deviceCode,
      });
    },
  };
}

export const testOauthDeviceProvider: DeviceAuthConnectorAuthProvider<
  "test-oauth-device",
  "oauth"
> = {
  grant: createTestOauthDeviceGrant<"oauth">(),
  access: {
    kind: "none",
    getAccessSecretName: () => {
      return TEST_OAUTH_DEVICE_ACCESS_SECRET_NAME;
    },
  },
  revoke: { kind: "none" },
};

export const testOauthDeviceApiProvider: DeviceAuthConnectorAuthProvider<
  "test-oauth-device",
  "api"
> = {
  grant: createTestOauthDeviceGrant<"api">(),
  access: {
    kind: "none",
    getAccessSecretName: () => {
      return TEST_OAUTH_DEVICE_API_ACCESS_SECRET_NAME;
    },
  },
  revoke: { kind: "none" },
};
