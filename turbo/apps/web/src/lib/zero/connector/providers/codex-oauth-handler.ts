import { type ProviderHandler } from "../provider-types";
import {
  buildChatgptAuthorizationUrl,
  exchangeChatgptCode,
  getChatgptRefreshSecretName,
  getChatgptSecretName,
  refreshChatgptToken,
} from "./codex-oauth";

/**
 * OAuth handler for the codex-oauth-token model provider type.
 *
 * The generic connector authorize endpoint still blocks `codex-oauth` so it
 * cannot create connector rows. Dedicated model-provider OAuth routes use this
 * handler to create `model_providers` rows with model-provider secrets.
 */
export const codexOauthHandler: ProviderHandler = {
  buildAuthUrl: (clientId, redirectUri, state) => {
    return buildChatgptAuthorizationUrl(clientId, redirectUri, state);
  },
  exchangeCode: async (
    clientId,
    _clientSecret,
    code,
    redirectUri,
    _state,
    codeVerifier,
  ) => {
    if (!codeVerifier) {
      throw new Error("ChatGPT OAuth requires PKCE code_verifier");
    }
    const result = await exchangeChatgptCode(
      clientId,
      code,
      redirectUri,
      codeVerifier,
    );
    return {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      expiresIn: result.expiresIn,
      scopes: [],
      userInfo: result.userInfo,
    };
  },
  refreshToken: refreshChatgptToken,
  getClientId: () => {
    return "app_EMoamEEZ73f0CkXaXp7hrann";
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: getChatgptSecretName,
  getRefreshSecretName: getChatgptRefreshSecretName,
};
