import { type ProviderHandler } from "../provider-types";
import {
  buildVercelAuthorizationUrl,
  exchangeVercelCode,
  getVercelSecretName,
  refreshVercelToken,
} from "./vercel";

export const vercelHandler: ProviderHandler = {
  buildAuthUrl: buildVercelAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri, state) {
    if (!state) {
      throw new Error(
        "Vercel PKCE requires state for code_verifier derivation",
      );
    }
    const result = await exchangeVercelCode(
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
  getClientId: (e) => e.VERCEL_OAUTH_CLIENT_ID,
  getClientSecret: (e) => e.VERCEL_OAUTH_CLIENT_SECRET,
  getSecretName: getVercelSecretName,
  getRefreshSecretName: () => "VERCEL_REFRESH_TOKEN",
  refreshToken: refreshVercelToken,
};
