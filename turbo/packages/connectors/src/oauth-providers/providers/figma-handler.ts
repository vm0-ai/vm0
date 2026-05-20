import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildFigmaAuthorizationUrl,
  exchangeFigmaCode,
  getFigmaSecretName,
  refreshFigmaToken,
} from "./figma";
export const figmaHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildFigmaAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeFigmaCode(
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
    return e.FIGMA_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.FIGMA_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getFigmaSecretName,
  getRefreshSecretName: () => {
    return "FIGMA_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshFigmaToken),
};
