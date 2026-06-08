import type { DeviceAuthConnectorAuthProvider } from "../../types";
import {
  pollBase44DeviceAuth,
  refreshBase44Token,
  startBase44DeviceAuth,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

export const base44Provider: DeviceAuthConnectorAuthProvider<"base44"> = {
  grant: {
    kind: "device-auth",
    startDeviceAuth: async (args) => {
      const { clientId } = args.authClient;
      return await startBase44DeviceAuth({
        clientId,
        scopes: args.scopes,
      });
    },
    pollDeviceAuth: async (args) => {
      const { clientId } = args.authClient;
      return await pollBase44DeviceAuth({
        clientId,
        deviceCode: args.deviceCode,
      });
    },
  },
  access: {
    kind: "refresh-token",
    refresh: async (args) => {
      const { clientId } = args.authClient;
      return oauthRefreshResultToProviderResult(
        await refreshBase44Token({
          clientId,
          refreshToken: args.inputs.refreshToken,
          signal: args.signal,
        }),
      );
    },
  },
  revoke: { kind: "none" },
};
