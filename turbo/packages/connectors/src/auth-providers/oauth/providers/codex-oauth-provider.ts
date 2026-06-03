import { type ModelProviderAuthProvider } from "../../types";
import { CHATGPT_OAUTH_CLIENT_ID, refreshChatgptToken } from "./codex-oauth";
import { oauthRefreshResultToProviderResult } from "../types";

type CodexOAuthRefreshOutputs = {
  readonly accessToken: string;
  readonly refreshToken?: string;
};

/**
 * Refresh provider for the codex-oauth-token model provider type.
 *
 * Browser OAuth setup is not supported. Users connect by pasting auth.json;
 * this provider only keeps the derived ChatGPT access token fresh server-side.
 */
const codexOauthProviderDefinition = {
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
      const refreshToken = args.inputs.refreshToken;
      if (!refreshToken) {
        throw new Error("codex-oauth-token refreshToken input missing");
      }
      return oauthRefreshResultToProviderResult(
        await refreshChatgptToken(
          args.authClient.clientId,
          refreshToken,
          args.signal,
        ),
      );
    },
  },
  revoke: {
    kind: "none",
  },
} satisfies ModelProviderAuthProvider<CodexOAuthRefreshOutputs>;

export const codexOauthProvider: ModelProviderAuthProvider<CodexOAuthRefreshOutputs> =
  codexOauthProviderDefinition;
