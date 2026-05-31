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
    startDeviceAuth: async (args) => {
      return await startSlockDeviceAuth({
        deviceAuthGrant: args.deviceAuthGrant,
      });
    },
    pollDeviceAuth: async (args) => {
      return await pollSlockDeviceAuth({
        deviceAuthGrant: args.deviceAuthGrant,
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
        tokenUrl: args.tokenUrl,
        refreshToken: args.refreshToken,
        signal: args.signal,
      });
    },
  },
  revoke: { kind: "none" },
};
