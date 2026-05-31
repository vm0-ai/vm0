import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "../google";
export const googleAdsProvider: AuthCodeConnectorAuthProvider<"google-ads"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      const redirectUri = args.redirectUri;
      const state = args.state;
      return buildGoogleAuthorizationUrl(
        "google-ads",
        clientId,
        redirectUri,
        state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeGoogleOAuthCode(
        "google-ads",
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
        expiresIn: result.expiresIn,
        scopes: result.scopes,
        userInfo: {
          id: result.userInfo.id,
          username: result.userInfo.name,
          email: result.userInfo.email,
        },
      };
    },
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: () => {
      return "GOOGLE_ADS_ACCESS_TOKEN";
    },
    getRefreshSecretName: () => {
      return "GOOGLE_ADS_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      const refreshToken = args.refreshToken;
      return refreshGoogleToken(
        "google-ads",
        clientId,
        clientSecret,
        refreshToken,
        args.signal,
      );
    },
  },
  revoke: { kind: "none" },
};
