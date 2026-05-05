import { type ProviderHandler } from "../provider-types";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  buildChatgptAuthorizationUrl,
  exchangeChatgptCode,
  getChatgptRefreshSecretName,
  getChatgptSecretName,
  refreshChatgptToken,
  revokeChatgptToken,
} from "./chatgpt-oauth";

export const chatgptOauthHandler: ProviderHandler = {
  buildAuthUrl: buildChatgptAuthorizationUrl,
  async exchangeCode(
    clientId,
    clientSecret,
    code,
    redirectUri,
    _state,
    codeVerifier,
  ) {
    if (!codeVerifier) {
      throw new Error(
        "ChatGPT OAuth requires PKCE code_verifier for token exchange",
      );
    }
    const result = await exchangeChatgptCode(
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
        id: result.accountId,
        username: result.workspaceName,
        email: null,
      },
    };
  },
  refreshToken: refreshChatgptToken,
  revokeToken: revokeChatgptToken,
  getClientId: () => {
    return CHATGPT_OAUTH_CLIENT_ID;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: getChatgptSecretName,
  getRefreshSecretName: getChatgptRefreshSecretName,
};
