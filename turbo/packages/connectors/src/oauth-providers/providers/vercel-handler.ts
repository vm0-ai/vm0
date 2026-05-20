import {
  adaptClientCredentialCodeExchange,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildVercelAuthorizationUrl,
  exchangeVercelCode,
  getVercelSecretName,
} from "./vercel";
export const vercelHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildVercelAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeVercelCode(
        clientId,
        clientSecret,
        code,
        redirectUri,
      );
      return {
        accessToken: result.accessToken,
        scopes: [],
        userInfo: {
          id: result.userInfo.id,
          username: result.userInfo.username,
          email: result.userInfo.email,
        },
      };
    },
  ),
  getClientId: (e) => {
    return e.VERCEL_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.VERCEL_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getVercelSecretName,
};
