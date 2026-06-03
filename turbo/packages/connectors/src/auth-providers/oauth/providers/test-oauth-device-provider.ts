import type {
  DeviceAuthConnectorAuthProvider,
  DeviceAuthGrantProvider,
} from "../../types";
import {
  pollTestOAuthDeviceAuth,
  startTestOAuthDeviceAuth,
} from "./test-oauth-device";

function createTestOauthDeviceGrant(): DeviceAuthGrantProvider<
  "test-oauth-device",
  "oauth"
> {
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

function createTestOauthDeviceApiGrant(): DeviceAuthGrantProvider<
  "test-oauth-device",
  "api"
> {
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
  grant: createTestOauthDeviceGrant(),
  access: {
    kind: "none",
  },
  revoke: { kind: "none" },
};

export const testOauthDeviceApiProvider: DeviceAuthConnectorAuthProvider<
  "test-oauth-device",
  "api"
> = {
  grant: createTestOauthDeviceApiGrant(),
  access: {
    kind: "none",
  },
  revoke: { kind: "none" },
};
