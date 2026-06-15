import { type ModelProviderRefreshTokenAuthProvider } from "../../types";
import { CHATGPT_OAUTH_CLIENT_ID, refreshChatgptToken } from "./oauth";
import { oauthRefreshResultToProviderResult } from "../../oauth/types";

type CodexOAuthRefreshInputs = {
  readonly refreshToken: string;
};

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
} satisfies ModelProviderRefreshTokenAuthProvider<
  CodexOAuthRefreshInputs,
  CodexOAuthRefreshOutputs
>;

export const codexOauthProvider: ModelProviderRefreshTokenAuthProvider<
  CodexOAuthRefreshInputs,
  CodexOAuthRefreshOutputs
> = codexOauthProviderDefinition;
