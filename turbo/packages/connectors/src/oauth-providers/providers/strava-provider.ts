import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildStravaAuthorizationUrl,
  exchangeStravaCode,
  getStravaSecretName,
  refreshStravaToken,
} from "./strava";
export const stravaProvider = defineConnectorOAuthProvider("strava", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildStravaAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
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
  getSecretName: getStravaSecretName,
  getRefreshSecretName: () => {
    return "STRAVA_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshStravaToken(clientId, clientSecret, args.refreshToken);
  },
});
