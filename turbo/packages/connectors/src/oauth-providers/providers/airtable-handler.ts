import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildAirtableAuthorizationUrl,
  exchangeAirtableCode,
  getAirtableSecretName,
  refreshAirtableToken,
} from "./airtable";
export const airtableHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildAirtableAuthorizationUrl(
      clientId,
      args.redirectUri,
      args.state,
    );
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const codeVerifier = args.codeVerifier;
    const result = await exchangeAirtableCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
      codeVerifier,
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
    return e.AIRTABLE_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.AIRTABLE_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getAirtableSecretName,
  getRefreshSecretName: () => {
    return "AIRTABLE_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshAirtableToken(clientId, clientSecret, args.refreshToken);
  },
};
