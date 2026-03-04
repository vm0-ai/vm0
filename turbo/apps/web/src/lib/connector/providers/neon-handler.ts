import { type ProviderHandler } from "../provider-types";
import {
  buildNeonAuthorizationUrl,
  exchangeNeonCode,
  getNeonSecretName,
  refreshNeonToken,
} from "./neon";

export const neonHandler: ProviderHandler = {
  buildAuthUrl: buildNeonAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeNeonCode(
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
  getClientId: (e) => e.NEON_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.NEON_OAUTH_CLIENT_SECRET,
  getSecretName: getNeonSecretName,
  getRefreshSecretName: () => "NEON_REFRESH_TOKEN",
  refreshToken: refreshNeonToken,
};
