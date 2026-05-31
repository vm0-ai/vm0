import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildSupabaseAuthorizationUrl,
  exchangeSupabaseCode,
  getSupabaseSecretName,
  refreshSupabaseToken,
} from "./supabase";
export const supabaseProvider: AuthCodeConnectorAuthProvider<"supabase"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args;
      return buildSupabaseAuthorizationUrl(
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const state = args.state;
      if (!state) {
        throw new Error(
          "Supabase PKCE requires state for code_verifier derivation",
        );
      }
      const result = await exchangeSupabaseCode(
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
  },
  access: {
    kind: "refresh-token",
    getAccessSecretName: getSupabaseSecretName,
    getRefreshSecretName: () => {
      return "SUPABASE_REFRESH_TOKEN";
    },
    refreshToken: (args) => {
      const { clientId, clientSecret } = args;
      return refreshSupabaseToken(
        clientId,
        clientSecret,
        args.refreshToken,
        args.signal,
      );
    },
  },
  revoke: { kind: "none" },
};
