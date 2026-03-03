import { type ProviderHandler } from "../provider-types";
import {
  buildLinearAuthorizationUrl,
  exchangeLinearCode,
  getLinearSecretName,
  refreshLinearToken,
} from "./linear";

export const linearHandler: ProviderHandler = {
  buildAuthUrl: buildLinearAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
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
  getClientId: (e) => e.LINEAR_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.LINEAR_OAUTH_CLIENT_SECRET,
  getSecretName: getLinearSecretName,
  getRefreshSecretName: () => "LINEAR_REFRESH_TOKEN",
  refreshToken: refreshLinearToken,
};
