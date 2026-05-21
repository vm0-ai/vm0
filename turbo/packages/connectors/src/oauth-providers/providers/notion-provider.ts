import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildNotionAuthorizationUrl,
  exchangeNotionCode,
  getNotionSecretName,
  refreshNotionToken,
} from "./notion";
export const notionProvider = defineConnectorOAuthProvider("notion", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildNotionAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
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
  getSecretName: getNotionSecretName,
  getRefreshSecretName: () => {
    return "NOTION_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshNotionToken(clientId, clientSecret, args.refreshToken);
  },
});
