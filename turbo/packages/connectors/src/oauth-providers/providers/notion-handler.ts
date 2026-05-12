import { type ProviderHandler } from "../provider-types";
import {
  buildNotionAuthorizationUrl,
  exchangeNotionCode,
  getNotionSecretName,
  refreshNotionToken,
} from "./notion";

export const notionHandler: ProviderHandler = {
  buildAuthUrl: buildNotionAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri) {
    const result = await exchangeNotionCode(
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
      userInfo: result.userInfo,
    };
  },
  getClientId: (e) => {
    return e.NOTION_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.NOTION_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getNotionSecretName,
  getRefreshSecretName: () => {
    return "NOTION_REFRESH_TOKEN";
  },
  refreshToken: refreshNotionToken,
};
