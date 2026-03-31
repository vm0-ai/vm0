import { type ProviderHandler } from "../provider-types";
import {
  buildSpotifyAuthorizationUrl,
  exchangeSpotifyCode,
  getSpotifySecretName,
  refreshSpotifyToken,
} from "./spotify";

export const spotifyHandler: ProviderHandler = {
  buildAuthUrl: buildSpotifyAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
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
  getClientId: (e) => {
    return e.SPOTIFY_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.SPOTIFY_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getSpotifySecretName,
  getRefreshSecretName: () => {
    return "SPOTIFY_REFRESH_TOKEN";
  },
  refreshToken: refreshSpotifyToken,
};
