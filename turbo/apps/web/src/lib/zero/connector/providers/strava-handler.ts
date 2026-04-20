import { type ProviderHandler } from "../provider-types";
import {
  buildStravaAuthorizationUrl,
  exchangeStravaCode,
  getStravaSecretName,
  refreshStravaToken,
} from "./strava";

export const stravaHandler: ProviderHandler = {
  buildAuthUrl: buildStravaAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code) {
    const result = await exchangeStravaCode(clientId, clientSecret, code);
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
    return e.STRAVA_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.STRAVA_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getStravaSecretName,
  getRefreshSecretName: () => {
    return "STRAVA_REFRESH_TOKEN";
  },
  refreshToken: refreshStravaToken,
};
