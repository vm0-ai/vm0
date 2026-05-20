import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildLinearAuthorizationUrl,
  exchangeLinearCode,
  getLinearSecretName,
  refreshLinearToken,
  revokeLinearToken,
} from "./linear";
export const linearHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildLinearAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeLinearCode(
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
    return e.LINEAR_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.LINEAR_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getLinearSecretName,
  getRefreshSecretName: () => {
    return "LINEAR_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshLinearToken(clientId, clientSecret, args.refreshToken);
  },
  revokeToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return revokeLinearToken(clientId, clientSecret, args.accessToken);
  },
};
