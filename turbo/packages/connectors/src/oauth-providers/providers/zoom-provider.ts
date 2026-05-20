import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildZoomAuthorizationUrl,
  exchangeZoomCode,
  getZoomSecretName,
  refreshZoomToken,
} from "./zoom";
export const zoomProvider: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildZoomAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeZoomCode(
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
    return e.ZOOM_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.ZOOM_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getZoomSecretName,
  getRefreshSecretName: () => {
    return "ZOOM_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshZoomToken(clientId, clientSecret, args.refreshToken);
  },
};
