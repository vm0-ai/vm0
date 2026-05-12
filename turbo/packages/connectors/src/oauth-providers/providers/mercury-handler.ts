import { type ProviderHandler } from "../provider-types";
import {
  buildMercuryAuthorizationUrl,
  exchangeMercuryCode,
  getMercurySecretName,
  refreshMercuryToken,
} from "./mercury";

export const mercuryHandler: ProviderHandler = {
  buildAuthUrl: buildMercuryAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeMercuryCode(
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
    return e.MERCURY_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.MERCURY_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getMercurySecretName,
  getRefreshSecretName: () => {
    return "MERCURY_REFRESH_TOKEN";
  },
  refreshToken: refreshMercuryToken,
};
