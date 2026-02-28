import { type ProviderHandler } from "../provider-types";
import {
  buildNotionAuthorizationUrl,
  exchangeNotionCode,
  getNotionSecretName,
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
      scopes: result.scopes,
      userInfo: result.userInfo,
    };
  },
  getClientId: (e) => e.NOTION_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.NOTION_OAUTH_CLIENT_SECRET,
  getSecretName: getNotionSecretName,
};
