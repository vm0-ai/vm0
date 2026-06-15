import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildTikTokAdsAuthorizationUrl,
  exchangeTikTokAdsCode,
  refreshTikTokAdsToken,
} from "./oauth";

export const tiktokAdsProvider: AuthCodeConnectorAuthProvider<"tiktok-ads"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildTikTokAdsAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const result = await exchangeTikTokAdsCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        args.code,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: {
          id: result.userInfo.id,
          username: result.userInfo.username,
          email: result.userInfo.email,
        },
      };
    },
  },
  access: {
    kind: "refresh-token",
    refresh: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const currentRefreshToken = args.inputs.refreshToken;
      const result = await refreshTikTokAdsToken(
        clientId,
        clientSecret,
        currentRefreshToken,
        args.signal,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken ?? currentRefreshToken,
        },
        expiresIn: result.expiresIn,
      };
    },
  },
  revoke: { kind: "none" },
};
