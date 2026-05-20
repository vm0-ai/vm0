import {
  adaptClientCredentialCodeExchange,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildWebflowAuthorizationUrl,
  exchangeWebflowCode,
  getWebflowSecretName,
} from "./webflow";
export const webflowHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildWebflowAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeWebflowCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        refreshToken: null,
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
    return e.WEBFLOW_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.WEBFLOW_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getWebflowSecretName,
};
