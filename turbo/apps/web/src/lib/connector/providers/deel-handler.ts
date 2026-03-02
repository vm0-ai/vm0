import { type ProviderHandler } from "../provider-types";
import {
  buildDeelAuthorizationUrl,
  exchangeDeelCode,
  getDeelSecretName,
} from "./deel";

export const deelHandler: ProviderHandler = {
  buildAuthUrl: buildDeelAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeDeelCode(
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
  getClientId: (e) => e.DEEL_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.DEEL_OAUTH_CLIENT_SECRET,
  getSecretName: getDeelSecretName,
  getRefreshSecretName: () => "DEEL_REFRESH_TOKEN",
};
