import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildCanvaAuthorizationUrl,
  exchangeCanvaCode,
  getCanvaSecretName,
  refreshCanvaToken,
} from "./canva";
export const canvaHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildCanvaAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri, state) => {
      if (!state) {
        throw new Error(
          "Canva PKCE requires state for code_verifier derivation",
        );
      }
      const result = await exchangeCanvaCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
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
  ),
  getClientId: (e) => {
    return e.CANVA_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.CANVA_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getCanvaSecretName,
  getRefreshSecretName: () => {
    return "CANVA_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshCanvaToken),
};
