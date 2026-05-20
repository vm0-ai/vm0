import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildXeroAuthorizationUrl,
  exchangeXeroCode,
  getXeroSecretName,
  refreshXeroToken,
} from "./xero";
export const xeroHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildXeroAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeXeroCode(
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
    return e.XERO_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.XERO_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getXeroSecretName,
  getRefreshSecretName: () => {
    return "XERO_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshXeroToken),
};
