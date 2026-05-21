import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildSpotifyAuthorizationUrl,
  exchangeSpotifyCode,
  getSpotifySecretName,
  refreshSpotifyToken,
} from "./spotify";
export const spotifyProvider = defineConnectorOAuthProvider("spotify", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildSpotifyAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeSpotifyCode(
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
        username: result.userInfo.username,
        email: result.userInfo.email,
      },
    };
  },
  getSecretName: getSpotifySecretName,
  getRefreshSecretName: () => {
    return "SPOTIFY_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshSpotifyToken(clientId, clientSecret, args.refreshToken);
  },
});
