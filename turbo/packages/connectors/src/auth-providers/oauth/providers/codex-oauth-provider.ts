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
    resolveAuthClient: () => {
      return {
        clientRegistration: "static",
        clientType: "public",
        clientId: CHATGPT_OAUTH_CLIENT_ID,
      };
    },
    refreshToken: (args) => {
      return refreshChatgptToken(
        args.authClient.clientId,
        args.refreshToken,
        args.signal,
      );
    },
  },
  revoke: {
    kind: "none",
  },
};
