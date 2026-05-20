import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildPosthogAuthorizationUrl,
  exchangePosthogCode,
  getPosthogSecretName,
  refreshPosthogToken,
} from "./posthog";
export const posthogHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildPosthogAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangePosthogCode(
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
    return e.POSTHOG_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.POSTHOG_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getPosthogSecretName,
  getRefreshSecretName: () => {
    return "POSTHOG_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshPosthogToken),
};
