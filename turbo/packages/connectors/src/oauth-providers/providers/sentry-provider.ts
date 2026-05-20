import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildSentryAuthorizationUrl,
  exchangeSentryCode,
  getSentrySecretName,
  refreshSentryToken,
} from "./sentry";
export const sentryProvider: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildSentryAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
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
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshSentryToken(clientId, clientSecret, args.refreshToken);
  },
};
