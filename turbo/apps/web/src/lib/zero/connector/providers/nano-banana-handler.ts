import { type ProviderHandler } from "../provider-types";

/**
 * Nano Banana (Google Gemini image generation) uses the `platform` auth
 * method: enablement is a plain row in `user_platform_connectors` — no
 * user-supplied credentials, no sentinel secret. The platform injects its
 * own Google API key at proxy time.
 *
 * The OAuth-only slots below throw by design. All current call-sites are
 * already OAuth-guarded:
 * - `upsertOAuthConnector` → `getSecretName`: reached only via OAuth
 *   callback, which filters by `authMethods.oauth` presence upstream.
 * - `revokeConnectorToken` / refresh-secret lookup in `deleteConnector`:
 *   guarded by `existing.authMethod === "oauth"`.
 * - `refreshConnectorAccessToken`, `getConnectorAccessToken`,
 *   `getConnectorRefreshToken`: reached only via `secretConnectorMap`,
 *   built in `resolve-connectors.ts` from handlers where
 *   `handler.refreshToken` is truthy — this stub omits that field.
 * - `getConfiguredConnectorTypes`: reads `getClientId` / `getClientSecret`
 *   (both `undefined` here) and falls through via `api-token` check
 *   (not platform). Never calls `getSecretName`.
 *
 * If a future call-site needs platform support, promote these stubs to
 * real implementations or extend `ProviderHandler` with an optional slot
 * rather than silencing the throw.
 */
export const nanoBananaHandler: ProviderHandler = {
  buildAuthUrl() {
    throw new Error("Nano Banana uses platform auth — no OAuth flow");
  },
  exchangeCode() {
    throw new Error("Nano Banana uses platform auth — no OAuth flow");
  },
  getClientId: () => {
    return undefined;
  },
  getClientSecret: () => {
    return undefined;
  },
  getSecretName: () => {
    throw new Error("Nano Banana uses platform auth — no connector secret");
  },
};
