import { type ProviderHandler } from "../provider-types";
import {
  buildXeroAuthorizationUrl,
  exchangeXeroCode,
  getXeroSecretName,
  refreshXeroToken,
} from "./xero";

export const xeroHandler: ProviderHandler = {
  buildAuthUrl: buildXeroAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeXeroCode(
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
  getClientId: (e) => e.XERO_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.XERO_OAUTH_CLIENT_SECRET,
  getSecretName: getXeroSecretName,
  getRefreshSecretName: () => "XERO_REFRESH_TOKEN",
  refreshToken: refreshXeroToken,
};
