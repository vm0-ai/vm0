import { type ModelProviderAuthProvider } from "../../types";
import { CHATGPT_OAUTH_CLIENT_ID, refreshChatgptToken } from "./codex-oauth";
import { oauthRefreshResultToProviderResult } from "../types";

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
    resolveAuthClient: () => {
      return {
        clientRegistration: "static",
        clientType: "public",
        clientId: CHATGPT_OAUTH_CLIENT_ID,
      };
    },
    refresh: async (args) => {
      return oauthRefreshResultToProviderResult(
        await refreshChatgptToken(
          args.authClient.clientId,
          args.inputs.refreshToken,
          args.signal,
        ),
      );
    },
  },
  revoke: {
    kind: "none",
  },
};
