import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildPosthogAuthorizationUrl,
  exchangePosthogCode,
  getPosthogSecretName,
  refreshPosthogToken,
} from "./posthog";
export const posthogHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildPosthogAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
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
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshPosthogToken(clientId, clientSecret, args.refreshToken);
  },
};
