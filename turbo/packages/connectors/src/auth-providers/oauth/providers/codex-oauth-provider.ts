import { type ModelProviderAuthProvider } from "../../types";
import {
  CHATGPT_OAUTH_CLIENT_ID,
  getChatgptRefreshSecretName,
  getChatgptSecretName,
  refreshChatgptToken,
} from "./codex-oauth";

/**
 * Refresh provider for the codex-oauth-token model provider type.
 *
 * Browser OAuth setup is not supported. Users connect by pasting auth.json;
 * this provider only keeps the derived ChatGPT access token fresh server-side.
 */
export const codexOauthProvider: ModelProviderAuthProvider = {
  grant: {
    kind: "none",
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: getChatgptSecretName,
    getRefreshSecretName: getChatgptRefreshSecretName,
    getClientId: () => {
      return CHATGPT_OAUTH_CLIENT_ID;
    },
    getClientSecret: () => {
      return undefined;
    },
    refreshToken: (args) => {
      return refreshChatgptToken(
        args.clientId ?? CHATGPT_OAUTH_CLIENT_ID,
        args.clientSecret ?? "",
        args.refreshToken,
      );
    },
  },
  revoke: {
    kind: "none",
  },
};
