import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientCredentialTokenRevocation,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildLinearAuthorizationUrl,
  exchangeLinearCode,
  getLinearSecretName,
  refreshLinearToken,
  revokeLinearToken,
} from "./linear";
export const linearHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildLinearAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeLinearCode(
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
    return e.LINEAR_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.LINEAR_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getLinearSecretName,
  getRefreshSecretName: () => {
    return "LINEAR_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshLinearToken),
  revokeToken: adaptClientCredentialTokenRevocation(revokeLinearToken),
};
