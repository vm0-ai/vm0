import { type ProviderHandler } from "../provider-types";
import {
  buildGarminConnectAuthorizationUrl,
  exchangeGarminConnectCode,
  getGarminConnectSecretName,
  refreshGarminConnectToken,
} from "./garmin-connect";

export const garminConnectHandler: ProviderHandler = {
  buildAuthUrl: buildGarminConnectAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, _redirectUri, state) {
    if (!state) {
      throw new Error(
        "Garmin Connect PKCE requires state for code_verifier derivation",
      );
    }
    const result = await exchangeGarminConnectCode(
      clientId,
      clientSecret,
      code,
      state,
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
    return e.GARMIN_CONNECT_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.GARMIN_CONNECT_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getGarminConnectSecretName,
  getRefreshSecretName: () => {
    return "GARMIN_CONNECT_REFRESH_TOKEN";
  },
  refreshToken: refreshGarminConnectToken,
};
