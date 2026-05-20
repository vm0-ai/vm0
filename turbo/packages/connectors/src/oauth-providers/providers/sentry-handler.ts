import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildSentryAuthorizationUrl,
  exchangeSentryCode,
  getSentrySecretName,
  refreshSentryToken,
} from "./sentry";
export const sentryHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildSentryAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
      const result = await exchangeSentryCode(
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
    return e.SENTRY_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.SENTRY_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getSentrySecretName,
  getRefreshSecretName: () => {
    return "SENTRY_REFRESH_TOKEN";
  },
  refreshToken: adaptClientCredentialTokenRefresh(refreshSentryToken),
};
