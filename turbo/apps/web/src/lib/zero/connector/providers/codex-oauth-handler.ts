import { type ProviderHandler } from "../provider-types";
import {
  getChatgptRefreshSecretName,
  getChatgptSecretName,
  refreshChatgptToken,
} from "./codex-oauth";

const REFRESH_ONLY_MESSAGE =
  "codex-oauth is refresh-only — providers are added via the codex auth.json paste flow, not OAuth code exchange";

/**
 * Refresh-only handler for the codex-oauth-token model provider type.
 *
 * The full OAuth flow (authorize/exchange/revoke) was removed in favor of the
 * paste-based codex auth.json flow. This handler stays registered in
 * PROVIDER_HANDLERS so the firewall refresh pipeline can call
 * refreshChatgptToken when ChatGPT returns 401. The buildAuthUrl/exchangeCode
 * stubs throw because the connectors framework no longer dispatches to this
 * handler (the codex-oauth connector entry was removed alongside the routes).
 */
export const codexOauthHandler: ProviderHandler = {
  buildAuthUrl: () => {
    throw new Error(REFRESH_ONLY_MESSAGE);
  },
  exchangeCode: async () => {
    throw new Error(REFRESH_ONLY_MESSAGE);
  },
  refreshToken: refreshChatgptToken,
  getClientId: () => {
    return "app_EMoamEEZ73f0CkXaXp7hrann";
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: getChatgptSecretName,
  getRefreshSecretName: getChatgptRefreshSecretName,
};
