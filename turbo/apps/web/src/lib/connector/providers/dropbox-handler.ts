import { type ProviderHandler } from "../provider-types";
import {
  buildDropboxAuthorizationUrl,
  exchangeDropboxCode,
  getDropboxSecretName,
  refreshDropboxToken,
} from "./dropbox";

export const dropboxHandler: ProviderHandler = {
  buildAuthUrl: buildDropboxAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
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
  getClientId: (e) => e.DROPBOX_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.DROPBOX_OAUTH_CLIENT_SECRET,
  getSecretName: getDropboxSecretName,
  getRefreshSecretName: () => "DROPBOX_REFRESH_TOKEN",
  refreshToken: refreshDropboxToken,
};
