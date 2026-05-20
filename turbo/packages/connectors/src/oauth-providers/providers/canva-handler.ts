import {
  requireOAuthClientCredentials,
  requireOAuthClientId,
  type OAuthConnectorProvider,
} from "../provider-types";
import {
  buildCanvaAuthorizationUrl,
  exchangeCanvaCode,
  getCanvaSecretName,
  refreshCanvaToken,
} from "./canva";
export const canvaHandler: OAuthConnectorProvider = {
  buildAuthUrl: (args) => {
    const clientId = requireOAuthClientId(args);
    return buildCanvaAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    const code = args.code;
    const redirectUri = args.redirectUri;
    const state = args.state;
    if (!state) {
      throw new Error("Canva PKCE requires state for code_verifier derivation");
    }
    const result = await exchangeCanvaCode(
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
    return e.CANVA_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.CANVA_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getCanvaSecretName,
  getRefreshSecretName: () => {
    return "CANVA_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = requireOAuthClientCredentials(args);
    return refreshCanvaToken(clientId, clientSecret, args.refreshToken);
  },
};
