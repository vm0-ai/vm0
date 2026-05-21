import { defineConnectorOAuthProvider } from "../provider-types";
import {
  buildXAuthorizationUrl,
  exchangeXCode,
  getXSecretName,
  refreshXToken,
} from "./x";
export const xProvider = defineConnectorOAuthProvider("x", {
  buildAuthUrl: (args) => {
    const { clientId } = args;
    return buildXAuthorizationUrl(clientId, args.redirectUri, args.state);
  },
  exchangeCode: async (args) => {
    const { clientId, clientSecret } = args;
    const code = args.code;
    const redirectUri = args.redirectUri;
    const state = args.state;
    if (!state) {
      throw new Error("X PKCE requires state for code_verifier derivation");
    }
    const result = await exchangeXCode(
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
  getSecretName: getXSecretName,
  getRefreshSecretName: () => {
    return "X_REFRESH_TOKEN";
  },
  refreshToken: (args) => {
    const { clientId, clientSecret } = args;
    return refreshXToken(clientId, clientSecret, args.refreshToken);
  },
});
