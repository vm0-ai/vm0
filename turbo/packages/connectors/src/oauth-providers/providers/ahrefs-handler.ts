import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildAhrefsAuthorizationUrl,
  exchangeAhrefsCode,
  getAhrefsSecretName,
  refreshAhrefsToken,
} from "./ahrefs";
export const ahrefsHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildAhrefsAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeAhrefsCode(
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
  ),
  getClientId: (e) => {
    return e.AHREFS_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.AHREFS_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getAhrefsSecretName,
  getRefreshSecretName: () => {
    return "AHREFS_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshAhrefsToken),
};
