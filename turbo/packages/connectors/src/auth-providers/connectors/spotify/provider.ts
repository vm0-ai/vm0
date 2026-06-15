import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildSpotifyAuthorizationUrl,
  exchangeSpotifyCode,
  refreshSpotifyToken,
} from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";
export const spotifyProvider: AuthCodeConnectorAuthProvider<"spotify"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildSpotifyAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const result = await exchangeSpotifyCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
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
      return oauthRefreshResultToProviderResult(
        await refreshSpotifyToken(
          clientId,
          clientSecret,
          args.inputs.refreshToken,
          args.signal,
        ),
      );
    },
  },
  revoke: { kind: "none" },
};
