import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildAhrefsAuthorizationUrl,
  exchangeAhrefsCode,
  getAhrefsSecretName,
  refreshAhrefsToken,
} from "./ahrefs";
export const ahrefsProvider: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildAhrefsAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeAhrefsCode(
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
    return e.AHREFS_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.AHREFS_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getAhrefsSecretName,
  getRefreshSecretName: () => {
    return "AHREFS_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshAhrefsToken(clientId, clientSecret, args.refreshToken);
  },
};
