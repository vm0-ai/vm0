import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildDropboxAuthorizationUrl,
  exchangeDropboxCode,
  getDropboxSecretName,
  refreshDropboxToken,
} from "./dropbox";
export const dropboxProvider: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildDropboxAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeDropboxCode(
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
        username: result.userInfo.username,
        email: result.userInfo.email,
      },
    };
  },
  getClientId: (e) => {
    return e.DROPBOX_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.DROPBOX_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getDropboxSecretName,
  getRefreshSecretName: () => {
    return "DROPBOX_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshDropboxToken(clientId, clientSecret, args.refreshToken);
  },
};
