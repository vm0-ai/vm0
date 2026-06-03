import type { AuthCodeConnectorAuthProvider } from "../../types";
import {
  buildSupabaseAuthorizationUrl,
  exchangeSupabaseCode,
  refreshSupabaseToken,
} from "./supabase";
import { oauthRefreshResultToProviderResult } from "../types";
export const supabaseProvider: AuthCodeConnectorAuthProvider<"supabase"> = {
  grant: {
    kind: "auth-code",
    buildAuthUrl: (args) => {
      const { clientId } = args.authClient;
      return buildSupabaseAuthorizationUrl(
        args.authCodeGrant,
        clientId,
        args.redirectUri,
        args.state,
      );
    },
    exchangeCode: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      const code = args.code;
      const redirectUri = args.redirectUri;
      const state = args.state;
      if (!state) {
        throw new Error(
          "Supabase PKCE requires state for code_verifier derivation",
        );
      }
      const result = await exchangeSupabaseCode(
        args.authCodeGrant,
        clientId,
        clientSecret,
        code,
        redirectUri,
        state,
      );
      return {
        outputs: {
          accessToken: result.accessToken,
          refreshToken: result.refreshToken,
        },
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
    refresh: async (args) => {
      const { clientId, clientSecret } = args.authClient;
      return oauthRefreshResultToProviderResult(
        await refreshSupabaseToken(
          clientId,
          clientSecret,
          args.inputs.refreshToken,
          args.signal,
        ),
      );
    },
  },
  revoke: { kind: "none" },
};
