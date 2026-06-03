import type {
  DeviceAuthConnectorAuthProvider,
  DeviceAuthGrantProvider,
} from "../../types";
import type { ConnectorDeviceAuthGrantAuthMethodId } from "../../../connectors";
import {
  pollTestOAuthDeviceAuth,
  startTestOAuthDeviceAuth,
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
        scopes: args.scopes,
      });
    },
    pollDeviceAuth: async (args) => {
      const { clientId } = args.authClient;
      return await pollTestOAuthDeviceAuth({
        clientId,
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
  },
  revoke: { kind: "none" },
};
