import { type ProviderHandler } from "../provider-types";
import {
  buildWixAuthorizationUrl,
  exchangeWixCode,
  getWixSecretName,
  refreshWixToken,
} from "./wix";

export const wixHandler: ProviderHandler = {
  buildAuthUrl: (clientId) => buildWixAuthorizationUrl(clientId),
  async exchangeCode(clientId, clientSecret, code) {
    // For Wix, `code` is the instanceId obtained from the Dashboard Page
    // extension iFrame's ?instance=<JWT> parameter. The Wix custom app OAuth
    // uses client_credentials flow with instanceId.
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
