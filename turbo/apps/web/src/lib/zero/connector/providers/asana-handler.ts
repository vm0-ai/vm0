import { type ProviderHandler } from "../provider-types";
import {
  buildAsanaAuthorizationUrl,
  exchangeAsanaCode,
  getAsanaSecretName,
  refreshAsanaToken,
} from "./asana";

export const asanaHandler: ProviderHandler = {
  buildAuthUrl: buildAsanaAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeAsanaCode(
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
    return e.ASANA_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.ASANA_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getAsanaSecretName,
  getRefreshSecretName: () => {
    return "ASANA_REFRESH_TOKEN";
  },
  refreshToken: refreshAsanaToken,
};
