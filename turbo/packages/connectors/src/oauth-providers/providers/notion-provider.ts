import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildNotionAuthorizationUrl,
  exchangeNotionCode,
  getNotionSecretName,
  refreshNotionToken,
} from "./notion";
export const notionProvider: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildNotionAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
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
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshNotionToken(clientId, clientSecret, args.refreshToken);
  },
};
