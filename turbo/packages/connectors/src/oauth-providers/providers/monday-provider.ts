import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildMondayAuthorizationUrl,
  exchangeMondayCode,
  getMondaySecretName,
  refreshMondayToken,
} from "./monday";
export const mondayProvider: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildMondayAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeMondayCode(
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
    return e.MONDAY_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.MONDAY_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getMondaySecretName,
  getRefreshSecretName: () => {
    return "MONDAY_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshMondayToken(clientId, clientSecret, args.refreshToken);
  },
};
