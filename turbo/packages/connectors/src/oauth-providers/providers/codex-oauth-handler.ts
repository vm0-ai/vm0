import { type ModelProviderRefreshHandler } from "../provider-types";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  getChatgptRefreshSecretName,
  getChatgptSecretName,
  refreshChatgptToken,
} from "./codex-oauth";

/**
 * Refresh handler for the codex-oauth-token model provider type.
 *
 * Browser OAuth setup is not supported. Users connect by pasting auth.json;
 * this handler only keeps the derived ChatGPT access token fresh server-side.
 */
export const codexOauthHandler: ModelProviderRefreshHandler = {
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
