import { type ProviderHandler } from "../provider-types";
import {
  buildSupabaseAuthorizationUrl,
  exchangeSupabaseCode,
  getSupabaseSecretName,
  refreshSupabaseToken,
} from "./supabase";

export const supabaseHandler: ProviderHandler = {
  buildAuthUrl: buildSupabaseAuthorizationUrl,
  async exchangeCode(clientId, clientSecret, code, redirectUri, state) {
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
  getClientId: (e) => {
    return e.SUPABASE_OAUTH_CLIENT_ID;
  },
  getClientSecret: (e) => {
    return e.SUPABASE_OAUTH_CLIENT_SECRET;
  },
  getSecretName: getSupabaseSecretName,
  getRefreshSecretName: () => {
    return "SUPABASE_REFRESH_TOKEN";
  },
  refreshToken: refreshSupabaseToken,
};
