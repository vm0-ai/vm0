import { type ProviderHandler } from "../provider-types";
import {
  buildWixAuthorizationUrl,
  exchangeWixCode,
  getWixSecretName,
  refreshWixToken,
} from "./wix";

export const wixHandler: ProviderHandler = {
  buildAuthUrl: buildWixAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code) {
    // For Wix, `code` is actually the instanceId extracted from the
    // Wix instance JWT. The new Wix OAuth uses client_credentials
    // flow with instanceId instead of authorization_code.
    const result = await exchangeWixCode(clientId, clientSecret, code);
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
  getClientId: (e) => e.WIX_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.WIX_OAUTH_CLIENT_SECRET,
  getSecretName: getWixSecretName,
  getRefreshSecretName: () => "WIX_REFRESH_TOKEN",
  refreshToken: refreshWixToken,
};
