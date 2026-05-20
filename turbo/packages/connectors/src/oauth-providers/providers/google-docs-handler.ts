import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildGoogleAuthorizationUrl,
  exchangeGoogleOAuthCode,
  refreshGoogleToken,
} from "./google-oauth";
export const googleDocsHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    const redirectUri = args.redirectUri;
    const state = args.state;
    return buildGoogleAuthorizationUrl(
      "google-docs",
      clientId,
      redirectUri,
      state,
    );
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const result = await exchangeGoogleOAuthCode(
      "google-docs",
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
        username: result.userInfo.name,
        email: result.userInfo.email,
      },
    };
  },
  getClientId: (e) => {
    return e.GOOGLE_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.GOOGLE_OAUTH_CLIENT_SECRET;
  },
  getSecretName: () => {
    return "GOOGLE_DOCS_ACCESS_TOKEN";
  },
  getRefreshSecretName: () => {
    return "GOOGLE_DOCS_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const refreshToken = args.refreshToken;
    return refreshGoogleToken(
      "google-docs",
      clientId,
      clientSecret,
      refreshToken,
    );
  },
};
