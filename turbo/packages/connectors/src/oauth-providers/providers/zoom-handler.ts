import {
  adaptClientCredentialCodeExchange,
  adaptClientCredentialTokenRefresh,
  adaptClientIdAuthUrl,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildZoomAuthorizationUrl,
  exchangeZoomCode,
  getZoomSecretName,
  refreshZoomToken,
} from "./zoom";
export const zoomHandler: OAuthConnectorProvider = {
  buildAuthUrl: adaptClientIdAuthUrl(buildZoomAuthorizationUrl),
  exchangeCode: adaptClientCredentialCodeExchange(
    async (clientId, clientSecret, code, redirectUri) => {
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
  ),
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
  refreshToken: adaptClientCredentialTokenRefresh(refreshZoomToken),
};
