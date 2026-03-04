import { type ProviderHandler } from "../provider-types";
import {
  buildXAuthorizationUrl,
  exchangeXCode,
  getXSecretName,
  refreshXToken,
} from "./x";

export const xHandler: ProviderHandler = {
  buildAuthUrl: buildXAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri, state) {
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
  getClientId: (e) => e.X_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.X_OAUTH_CLIENT_SECRET,
  getSecretName: getXSecretName,
  getRefreshSecretName: () => "X_REFRESH_TOKEN",
  refreshToken: refreshXToken,
};
