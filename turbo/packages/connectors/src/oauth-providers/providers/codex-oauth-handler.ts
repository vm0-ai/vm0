import { type ProviderHandler } from "../provider-types";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  buildChatgptAuthorizationUrl,
  exchangeChatgptCode,
  getChatgptRefreshSecretName,
  getChatgptSecretName,
  refreshChatgptToken,
} from "./codex-oauth";

/**
 * OAuth handler for the codex-oauth-token model provider type.
 *
 * This is intentionally registered only as a model-provider OAuth handler, not
 * as a connector handler. Dedicated model-provider OAuth routes use it to
 * create `model_providers` rows with model-provider secrets.
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
    return CHATGPT_OAUTH_CLIENT_ID;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: getChatgptSecretName,
  getRefreshSecretName: getChatgptRefreshSecretName,
};
