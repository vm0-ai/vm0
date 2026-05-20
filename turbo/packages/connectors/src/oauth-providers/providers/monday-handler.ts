import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildMondayAuthorizationUrl,
  exchangeMondayCode,
  getMondaySecretName,
  refreshMondayToken,
} from "./monday";
export const mondayHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildMondayAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeMondayCode(
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
    return e.MONDAY_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.MONDAY_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getMondaySecretName,
  getRefreshSecretName: () => {
    return "MONDAY_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshMondayToken),
};
