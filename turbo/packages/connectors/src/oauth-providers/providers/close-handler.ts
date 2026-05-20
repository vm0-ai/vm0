import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildCloseAuthorizationUrl,
  exchangeCloseCode,
  getCloseSecretName,
  refreshCloseToken,
} from "./close";
export const closeHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildCloseAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeCloseCode(
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
        username: result.userInfo.email,
        email: result.userInfo.email,
      },
    };
  },
  getClientId: (e) => {
    return e.CLOSE_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.CLOSE_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getCloseSecretName,
  getRefreshSecretName: () => {
    return "CLOSE_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshCloseToken(clientId, clientSecret, args.refreshToken);
  },
};
