import type { DeviceAuthConnectorAuthProvider } from "../../types";
import {
  pollSlockDeviceAuth,
  refreshSlockToken,
  startSlockDeviceAuth,
} from "./slock";
import { oauthRefreshResultToProviderResult } from "../types";

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
    refresh: async (args) => {
      return oauthRefreshResultToProviderResult(
        await refreshSlockToken({
          refreshToken: args.inputs.refreshToken,
          signal: args.signal,
        }),
      );
    },
  },
  revoke: { kind: "none" },
};
