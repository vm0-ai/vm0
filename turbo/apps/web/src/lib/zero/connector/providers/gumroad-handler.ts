import { type ProviderHandler } from "../provider-types";
import {
  buildGumroadAuthorizationUrl,
  exchangeGumroadCode,
  getGumroadSecretName,
  refreshGumroadToken,
} from "./gumroad";

export const gumroadHandler: ProviderHandler = {
  buildAuthUrl: buildGumroadAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeGumroadCode(
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
    return e.GUMROAD_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.GUMROAD_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getGumroadSecretName,
  getRefreshSecretName: () => {
    return "GUMROAD_REFRESH_TOKEN";
  },
  refreshToken: refreshGumroadToken,
};
