import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildStravaAuthorizationUrl,
  exchangeStravaCode,
  getStravaSecretName,
  refreshStravaToken,
} from "./strava";
export const stravaProvider: AuthCodeConnectorAuthProvider<"strava"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildStravaAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const code = args.code;
      const result = await exchangeStravaCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: result.refreshToken,
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
    getAccessSecretName: getStravaSecretName,
    getRefreshSecretName: () => {
      return "STRAVA_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args.authClient;
      return refreshStravaToken(
        args.tokenUrl,
        clientId,
        clientSecret,
        args.refreshToken,
        args.signal,
      );
    },
  },
  revoke: { kind: "none" },
};
