import type { DeviceAuthConnectorAuthProvider } from "../../types";
import {
  BASE44_ACCESS_SECRET_NAME,
  BASE44_REFRESH_SECRET_NAME,
  pollBase44DeviceAuth,
  refreshBase44Token,
  startBase44DeviceAuth,
} from "./base44";

export const base44Provider: DeviceAuthConnectorAuthProvider<"base44"> = {
  grant: {
    kind: "device-auth",
    startDeviceAuth: async (args) => {
      const { clientId } = args.authClient;
      return await startBase44DeviceAuth({
        clientId,
        deviceAuthGrant: args.deviceAuthGrant,
        scopes: args.scopes,
      });
    },
    pollDeviceAuth: async (args) => {
      const { clientId } = args.authClient;
      return await pollBase44DeviceAuth({
        clientId,
        deviceAuthGrant: args.deviceAuthGrant,
        deviceCode: args.deviceCode,
      });
    },
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: () => {
      return BASE44_ACCESS_SECRET_NAME;
    },
    getRefreshSecretName: () => {
      return BASE44_REFRESH_SECRET_NAME;
    },
    refreshToken: async (args) => {
      const { clientId } = args.authClient;
      return await refreshBase44Token({
        clientId,
        tokenUrl: args.tokenUrl,
        refreshToken: args.refreshToken,
        signal: args.signal,
      });
    },
  },
  revoke: { kind: "none" },
};
