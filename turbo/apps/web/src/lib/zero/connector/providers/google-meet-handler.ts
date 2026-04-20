import { type ProviderHandler } from "../provider-types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "./google-oauth";

export const googleMeetHandler: ProviderHandler = {
  buildAuthUrl: (clientId, redirectUri, state) => {
    return buildGoogleAuthorizationUrl(
      "google-meet",
      clientId,
      redirectUri,
      state,
    );
  },
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeGoogleOAuthCode(
      "google-meet",
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
  getClientId: (e) => {
    return e.GOOGLE_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.GOOGLE_OAUTH_CLIENT_SECRET;
  },
  getSecretName: () => {
    return "GOOGLE_MEET_ACCESS_TOKEN";
  },
  getRefreshSecretName: () => {
    return "GOOGLE_MEET_REFRESH_TOKEN";
  },
  refreshToken: (clientId, clientSecret, refreshToken) => {
    return refreshGoogleToken(
      "google-meet",
      clientId,
      clientSecret,
      refreshToken,
    );
  },
};
