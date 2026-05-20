import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildNeonAuthorizationUrl,
  exchangeNeonCode,
  getNeonSecretName,
  refreshNeonToken,
} from "./neon";
export const neonHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildNeonAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeNeonCode(
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
    return e.NEON_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.NEON_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getNeonSecretName,
  getRefreshSecretName: () => {
    return "NEON_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshNeonToken),
};
