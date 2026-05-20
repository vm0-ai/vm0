import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildMercuryAuthorizationUrl,
  exchangeMercuryCode,
  getMercurySecretName,
  refreshMercuryToken,
} from "./mercury";
export const mercuryHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildMercuryAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
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
  ),
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
  refreshToken: adaptClientCredentialTokenRefresh(refreshMercuryToken),
};
