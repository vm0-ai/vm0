import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildDocuSignAuthorizationUrl,
  exchangeDocuSignCode,
  getDocuSignSecretName,
  refreshDocuSignToken,
} from "./docusign";
export const docusignHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildDocuSignAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri, state) => {
      if (!state) {
        throw new Error(
          "DocuSign PKCE requires state for code_verifier derivation",
        );
      }
      const result = await exchangeDocuSignCode(
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
    return e.DOCUSIGN_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.DOCUSIGN_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getDocuSignSecretName,
  getRefreshSecretName: () => {
    return "DOCUSIGN_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshDocuSignToken),
};
