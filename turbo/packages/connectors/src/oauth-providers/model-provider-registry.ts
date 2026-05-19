import type { ProviderHandler } from "./provider-types";
import { codexOauthHandler } from "./providers/codex-oauth-handler";

export const MODEL_PROVIDER_OAUTH_HANDLERS = {
  "codex-oauth-token": codexOauthHandler,
} as const satisfies Record<string, ProviderHandler>;
