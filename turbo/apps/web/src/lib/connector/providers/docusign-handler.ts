import { type ProviderHandler } from "../provider-types";
import {
  buildDocuSignAuthorizationUrl,
  exchangeDocuSignCode,
  getDocuSignSecretName,
  refreshDocuSignToken,
} from "./docusign";

export const docusignHandler: ProviderHandler = {
  buildAuthUrl: buildDocuSignAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeDocuSignCode(
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
  getClientId: (e) => e.DOCUSIGN_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.DOCUSIGN_OAUTH_CLIENT_SECRET,
  getSecretName: getDocuSignSecretName,
  getRefreshSecretName: () => "DOCUSIGN_REFRESH_TOKEN",
  refreshToken: refreshDocuSignToken,
};
