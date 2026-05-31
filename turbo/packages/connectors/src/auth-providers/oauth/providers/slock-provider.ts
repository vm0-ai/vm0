import type { DeviceAuthConnectorAuthProvider } from "../../types";
import {
  SLOCK_ACCESS_SECRET_NAME,
  SLOCK_REFRESH_SECRET_NAME,
  pollSlockDeviceAuth,
  refreshSlockToken,
  startSlockDeviceAuth,
} from "./slock";

export const slockProvider: DeviceAuthConnectorAuthProvider<"slock"> = {
  grant: {
    kind: "device-auth",
    startDeviceAuth: async () => {
      return await startSlockDeviceAuth();
    },
    pollDeviceAuth: async (args) => {
      return await pollSlockDeviceAuth({
        deviceCode: args.deviceCode,
      });
    },
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: () => {
      return SLOCK_ACCESS_SECRET_NAME;
    },
    getRefreshSecretName: () => {
      return SLOCK_REFRESH_SECRET_NAME;
    },
    refreshToken: async (args) => {
      return await refreshSlockToken({
        refreshToken: args.refreshToken,
        signal: args.signal,
      });
    },
  },
  revoke: { kind: "none" },
};
