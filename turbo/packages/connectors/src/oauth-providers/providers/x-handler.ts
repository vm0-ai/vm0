import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildXAuthorizationUrl,
  exchangeXCode,
  getXSecretName,
  refreshXToken,
} from "./x";
export const xHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildXAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri, state) => {
      if (!state) {
        throw new Error("X PKCE requires state for code_verifier derivation");
      }
      const result = await exchangeXCode(
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
    return e.X_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.X_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getXSecretName,
  getRefreshSecretName: () => {
    return "X_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshXToken),
};
