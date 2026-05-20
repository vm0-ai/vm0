import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildDeelAuthorizationUrl,
  exchangeDeelCode,
  getDeelSecretName,
  refreshDeelToken,
} from "./deel";
export const deelHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildDeelAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const state = args.state;
    if (!state) {
      throw new Error("Deel PKCE requires state for code_verifier derivation");
    }
    const result = await exchangeDeelCode(
      clientId,
      clientSecret,
      code,
      redirectUri,
      state,
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
    return e.DEEL_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.DEEL_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getDeelSecretName,
  getRefreshSecretName: () => {
    return "DEEL_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshDeelToken(clientId, clientSecret, args.refreshToken);
  },
};
