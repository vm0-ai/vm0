import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildMercuryAuthorizationUrl,
  exchangeMercuryCode,
  getMercurySecretName,
  refreshMercuryToken,
} from "./mercury";
export const mercuryHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildMercuryAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeMercuryCode(
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
    return e.MERCURY_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.MERCURY_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getMercurySecretName,
  getRefreshSecretName: () => {
    return "MERCURY_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshMercuryToken(clientId, clientSecret, args.refreshToken);
  },
};
