import type { ModelProviderRefreshHandler } from "./provider-types";
import { codexOauthHandler } from "./providers/codex-oauth-handler";

export const MODEL_PROVIDER_OAUTH_HANDLERS = {
  "codex-oauth-token": codexOauthHandler,
} as const satisfies Record<string, ModelProviderRefreshHandler>;

export type ModelProviderOAuthHandlerKey =
  keyof typeof MODEL_PROVIDER_OAUTH_HANDLERS;

export type ModelProviderOAuthHandler =
  (typeof MODEL_PROVIDER_OAUTH_HANDLERS)[ModelProviderOAuthHandlerKey];

export function isModelProviderOAuthHandlerKey(
  handlerKey: string,
): handlerKey is ModelProviderOAuthHandlerKey {
  return Object.hasOwn(MODEL_PROVIDER_OAUTH_HANDLERS, handlerKey);
}

export function getModelProviderOAuthHandler(
  handlerKey: string,
): ModelProviderOAuthHandler | undefined {
  if (!isModelProviderOAuthHandlerKey(handlerKey)) {
    return undefined;
  }
  return MODEL_PROVIDER_OAUTH_HANDLERS[handlerKey];
}
